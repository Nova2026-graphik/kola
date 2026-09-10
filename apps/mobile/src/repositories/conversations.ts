import { and, desc, eq, isNull, sql } from 'drizzle-orm';

import type { ConversationRepository, ConversationView, Unsubscribe } from '@kola/core';

import { conversations, type LocalConversation } from '../db/schema';

import { conversationChanges } from './changes';
import type { RepositoryOptions } from './database';
import { enqueue } from './outbox';

/**
 * Repository des conversations.
 *
 * Alimente l'écran d'accueil (#29), qui doit s'afficher en moins de 500 ms au
 * démarrage, hors réseau compris. Le compte de non-lus est donc dérivé de deux
 * colonnes dénormalisées, jamais d'une agrégation sur les messages.
 */

function toView(row: LocalConversation): ConversationView {
  return {
    id: row.id,
    type: row.type,
    title: row.title,
    avatarUrl: row.avatarUrl,
    lastMessageAt: row.lastMessageAt,
    lastMessagePreview: row.lastMessagePreview,
    lastMessageSenderId: row.lastMessageSenderId,
    lastMessageKind: row.lastMessageKind,
    lastSeq: row.lastSeq,
    lastReadSeq: row.lastReadSeq,
    unreadCount: Math.max(row.lastSeq - row.lastReadSeq, 0),
    mutedUntil: row.mutedUntil,
    pinnedAt: row.pinnedAt,
    archivedAt: row.archivedAt,
  };
}

export function createConversationRepository(options: RepositoryOptions): ConversationRepository {
  const { db } = options;
  const now = options.now ?? (() => Date.now());
  const emit = conversationChanges.emit;

  return {
    listConversations: async () => {
      const rows = db
        .select()
        .from(conversations)
        .where(isNull(conversations.archivedAt))
        // Épinglées d'abord, puis par date du dernier message. C'est le tri de
        // l'écran d'accueil, servi par l'index sur last_message_at.
        .orderBy(
          desc(sql`case when ${conversations.pinnedAt} is null then 0 else 1 end`),
          desc(conversations.pinnedAt),
          desc(conversations.lastMessageAt),
        )
        .all();

      return rows.map(toView);
    },

    getConversation: async (id: string) => {
      const row = db.select().from(conversations).where(eq(conversations.id, id)).get();
      return row ? toView(row) : null;
    },

    markRead: async (conversationId: string, upToSeq: number) => {
      const at = now();

      db.transaction((tx) => {
        // Monotone : un accusé en retard, arrivé après une salve de
        // synchronisation, ne doit jamais faire reculer la lecture et
        // ressusciter des non-lus déjà vus.
        const updated = tx
          .update(conversations)
          .set({ lastReadSeq: sql`max(${conversations.lastReadSeq}, ${upToSeq})` })
          .where(
            and(
              eq(conversations.id, conversationId),
              sql`${conversations.lastReadSeq} < ${upToSeq}`,
            ),
          )
          .run();

        // Rien à propager si le curseur n'a pas bougé : inutile de dépenser une
        // requête réseau pour un accusé déjà envoyé.
        const changes = (updated as { changes?: number }).changes ?? 0;
        if (changes > 0) {
          enqueue(
            tx,
            {
              operation: 'mark_read',
              entityId: conversationId,
              conversationId,
              payload: { conversationId, upToSeq },
            },
            at,
          );
        }
      });

      emit();
    },

    subscribe: (listener: () => void): Unsubscribe => conversationChanges.subscribe(listener),
  };
}
