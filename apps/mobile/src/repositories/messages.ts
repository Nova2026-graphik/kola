import { and, desc, eq, isNull, lt, or, sql } from 'drizzle-orm';

import { MESSAGE_PAGE_SIZE } from '@kola/core';
import type {
  MessagePageQuery,
  MessageRepository,
  MessageView,
  SendMessageInput,
  Unsubscribe,
} from '@kola/core';

import { messages, type LocalMessage } from '../db/schema';

import type { LocalDatabase, RepositoryOptions } from './database';
import { clearDraftIn } from './drafts';
import { dequeue, enqueue } from './outbox';

/**
 * Repository des messages — seul point de passage vers les données.
 *
 * Lecture locale, écriture locale puis mise en file. Aucune méthode de ce
 * fichier ne touche au réseau (ADR-0002).
 */

function toView(row: LocalMessage): MessageView {
  return {
    clientId: row.clientId,
    id: row.id,
    conversationId: row.conversationId,
    senderId: row.senderId,
    seq: row.seq,
    kind: row.kind,
    body: row.body,
    replyToId: row.replyToId,
    editedAt: row.editedAt,
    deletedAt: row.deletedAt,
    createdAt: row.createdAt,
    syncStatus: row.syncStatus,
  };
}

/** Émetteur minimal, granulaire par conversation. */
class ChangeNotifier {
  private readonly listeners = new Map<string, Set<() => void>>();

  subscribe(key: string, listener: () => void): Unsubscribe {
    const set = this.listeners.get(key) ?? new Set();
    set.add(listener);
    this.listeners.set(key, set);
    return () => {
      set.delete(listener);
      if (set.size === 0) {
        this.listeners.delete(key);
      }
    };
  }

  emit(key: string): void {
    for (const listener of this.listeners.get(key) ?? []) {
      listener();
    }
  }
}

export function createMessageRepository(options: RepositoryOptions): MessageRepository {
  const { db } = options;
  const now = options.now ?? (() => Date.now());
  const newId = options.newId ?? (() => globalThis.crypto.randomUUID());
  const notifier = new ChangeNotifier();

  function readMessage(clientId: string): MessageView | null {
    const row = db.select().from(messages).where(eq(messages.clientId, clientId)).get();
    return row ? toView(row) : null;
  }

  return {
    getMessages: async (query: MessagePageQuery) => {
      const limit = query.limit ?? MESSAGE_PAGE_SIZE;

      // Les messages en attente n'ont pas encore de seq : ils sont les plus
      // récents par construction, et ne figurent que sur la première page.
      const pageFilter =
        query.beforeSeq === undefined || query.beforeSeq === null
          ? undefined
          : lt(messages.seq, query.beforeSeq);

      const rows = db
        .select()
        .from(messages)
        .where(
          and(
            eq(messages.conversationId, query.conversationId),
            eq(messages.hiddenLocally, false),
            ...(pageFilter ? [pageFilter] : []),
          ),
        )
        // Un message sans seq est en attente d'envoi : il se place après tous
        // ceux qui en ont un, donc en tête d'un tri décroissant.
        .orderBy(
          desc(sql`case when ${messages.seq} is null then 1 else 0 end`),
          desc(messages.seq),
          desc(messages.createdAt),
        )
        .limit(limit)
        .all();

      return rows.map(toView);
    },

    getMessage: async (clientId: string) => readMessage(clientId),

    sendMessage: async (input: SendMessageInput) => {
      const at = now();
      const clientId = input.clientId ?? newId();
      const kind = input.kind ?? 'text';

      // Le point critique de l'architecture : l'insertion locale et la mise en
      // file sont atomiques. L'une sans l'autre produit soit un message qui ne
      // part jamais, soit un envoi sans trace locale.
      db.transaction((tx) => {
        tx.insert(messages)
          .values({
            clientId,
            id: null,
            conversationId: input.conversationId,
            senderId: input.senderId,
            seq: null,
            kind,
            body: input.body,
            replyToId: input.replyToId ?? null,
            createdAt: at,
            syncStatus: 'pending',
          })
          .run();

        enqueue(
          tx,
          {
            operation: 'send_message',
            entityId: clientId,
            conversationId: input.conversationId,
            payload: {
              clientId,
              conversationId: input.conversationId,
              senderId: input.senderId,
              kind,
              body: input.body,
              replyToId: input.replyToId ?? null,
            },
          },
          at,
        );

        // Dans la même transaction que l'insertion : le champ et le brouillon
        // se vident ensemble, ou pas du tout. Un plantage entre les deux
        // laisserait le brouillon en place, et l'utilisateur réenverrait un
        // message déjà parti.
        if (input.clearDraft === true) {
          clearDraftIn(tx, input.conversationId);
        }
      });

      notifier.emit(input.conversationId);

      const view = readMessage(clientId);
      if (!view) {
        throw new Error(`message ${clientId} introuvable juste après son insertion`);
      }
      return view;
    },

    editMessage: async (clientId: string, body: string) => {
      const at = now();
      const existing = readMessage(clientId);
      if (!existing) {
        throw new Error(`message ${clientId} introuvable`);
      }
      if (existing.deletedAt !== null) {
        throw new Error('un message supprimé ne se modifie plus');
      }

      db.transaction((tx) => {
        tx.update(messages)
          .set({ body, editedAt: at, syncStatus: 'pending' })
          .where(eq(messages.clientId, clientId))
          .run();

        // Un message jamais parti n'a pas d'édition à propager : il suffit de
        // mettre à jour la charge utile de son envoi, encore en file.
        const operation = existing.id === null ? 'send_message' : 'edit_message';

        enqueue(
          tx,
          {
            operation,
            entityId: clientId,
            conversationId: existing.conversationId,
            payload:
              operation === 'send_message'
                ? {
                    clientId,
                    conversationId: existing.conversationId,
                    senderId: existing.senderId,
                    kind: existing.kind,
                    body,
                    replyToId: existing.replyToId,
                  }
                : { clientId, messageId: existing.id, body },
          },
          at,
        );
      });

      notifier.emit(existing.conversationId);

      const view = readMessage(clientId);
      if (!view) {
        throw new Error(`message ${clientId} introuvable après modification`);
      }
      return view;
    },

    deleteMessage: async (clientId: string, forEveryone: boolean) => {
      const at = now();
      const existing = readMessage(clientId);
      if (!existing) {
        throw new Error(`message ${clientId} introuvable`);
      }

      db.transaction((tx) => {
        if (!forEveryone) {
          // « Supprimer pour moi » ne quitte jamais l'appareil.
          tx.update(messages)
            .set({ hiddenLocally: true })
            .where(eq(messages.clientId, clientId))
            .run();
          return;
        }

        // Suppression logique : le seq est conservé, sinon la reprise par
        // curseur des clients hors ligne casserait (ADR-0002).
        tx.update(messages)
          .set({ deletedAt: at, body: null, syncStatus: 'pending' })
          .where(eq(messages.clientId, clientId))
          .run();

        if (existing.id === null) {
          // Le message n'est jamais parti : il suffit d'annuler son envoi.
          dequeue(tx, 'send_message', clientId);
          tx.update(messages)
            .set({ syncStatus: 'sent' })
            .where(eq(messages.clientId, clientId))
            .run();
          return;
        }

        enqueue(
          tx,
          {
            operation: 'delete_message',
            entityId: clientId,
            conversationId: existing.conversationId,
            payload: { clientId, messageId: existing.id },
          },
          at,
        );
      });

      notifier.emit(existing.conversationId);
    },

    retryMessage: async (clientId: string) => {
      const at = now();
      const existing = readMessage(clientId);
      if (!existing) {
        throw new Error(`message ${clientId} introuvable`);
      }

      db.transaction((tx) => {
        tx.update(messages)
          .set({ syncStatus: 'pending' })
          .where(eq(messages.clientId, clientId))
          .run();

        // Réémettre est sûr : le client_id est unique côté serveur, une
        // seconde réception est rejetée par la contrainte plutôt que dupliquée.
        enqueue(
          tx,
          {
            operation: 'send_message',
            entityId: clientId,
            conversationId: existing.conversationId,
            payload: {
              clientId,
              conversationId: existing.conversationId,
              senderId: existing.senderId,
              kind: existing.kind,
              body: existing.body,
              replyToId: existing.replyToId,
            },
          },
          at,
        );
      });

      notifier.emit(existing.conversationId);
    },

    discardMessage: async (clientId: string) => {
      const existing = readMessage(clientId);
      if (!existing) {
        return;
      }

      db.transaction((tx) => {
        dequeue(tx, 'send_message', clientId);
        tx.delete(messages).where(eq(messages.clientId, clientId)).run();
      });

      notifier.emit(existing.conversationId);
    },

    subscribe: (conversationId: string, listener: () => void) =>
      notifier.subscribe(conversationId, listener),
  };
}

/** Messages encore en attente ou en échec, pour le bandeau récapitulatif (#32). */
export function countUnsent(db: LocalDatabase, conversationId?: string): number {
  const row = db
    .select({ value: sql<number>`count(*)` })
    .from(messages)
    .where(
      and(
        or(eq(messages.syncStatus, 'pending'), eq(messages.syncStatus, 'failed')),
        isNull(messages.deletedAt),
        ...(conversationId ? [eq(messages.conversationId, conversationId)] : []),
      ),
    )
    .get();
  return row?.value ?? 0;
}
