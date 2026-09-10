import { and, desc, eq, isNull, sql } from 'drizzle-orm';

import type {
  AddMembersPayload,
  ConversationPrefs,
  ConversationPrefsPayload,
  ConversationRepository,
  ConversationView,
  CreateGroupInput,
  CreateGroupPayload,
  LeaveGroupPayload,
  MemberPayload,
  MemberView,
  SetMemberRolePayload,
  Unsubscribe,
  UpdateGroupInput,
  UpdateGroupPayload,
} from '@kola/core';

import {
  conversationMembers,
  conversations,
  profiles,
  type LocalConversation,
  type LocalMember,
} from '../db/schema';

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

type LocalProfile = typeof profiles.$inferSelect;

/** Ordre d'affichage des membres : propriétaire, administrateurs, puis le reste. */
function rank(role: MemberView['role']): number {
  return role === 'owner' ? 0 : role === 'admin' ? 1 : 2;
}

function toMemberView(row: LocalMember, profile: LocalProfile | undefined): MemberView {
  return {
    userId: row.userId,
    role: row.role,
    joinedAt: row.joinedAt,
    displayName: profile?.displayName ?? null,
    username: profile?.username ?? null,
    avatarUrl: profile?.avatarUrl ?? null,
  };
}

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
    description: row.description,
    restricted: row.restricted,
    myRole: row.myRole,
  };
}

export function createConversationRepository(options: RepositoryOptions): ConversationRepository {
  const { db } = options;
  const now = options.now ?? (() => Date.now());
  const newId = options.newId ?? (() => globalThis.crypto.randomUUID());
  const emit = conversationChanges.emit;

  /** Écrit localement puis met en file, dans une seule transaction. */
  function write(
    operation: Parameters<typeof enqueue>[1]['operation'],
    entityId: string,
    conversationId: string,
    payload: unknown,
    local: (tx: Parameters<Parameters<typeof db.transaction>[0]>[0]) => void,
  ): void {
    const at = now();
    db.transaction((tx) => {
      local(tx);
      // Écriture métier et mise en file ensemble : une modification appliquée
      // localement mais jamais mise en file resterait invisible pour les
      // autres, sans que rien ne le signale (ADR-0002).
      enqueue(tx, { operation, entityId, conversationId, payload }, at);
    });
    emit();
  }

  return {
    listMembers: async (conversationId: string): Promise<readonly MemberView[]> => {
      // Lecture purement locale : l'écran d'infos doit s'ouvrir hors ligne
      // comme tout le reste (#38, ADR-0002). Les membres arrivent par la
      // synchronisation, jamais à la demande depuis un écran.
      const rows = db
        .select()
        .from(conversationMembers)
        .where(
          and(
            eq(conversationMembers.conversationId, conversationId),
            // Un retrait posé hors ligne disparaît tout de suite de la liste :
            // sans cela, l'action semblerait n'avoir eu aucun effet.
            eq(conversationMembers.pendingRemoval, false),
          ),
        )
        .all();

      const known = new Map(
        db
          .select()
          .from(profiles)
          .all()
          .map((row) => [row.id, row] as const),
      );

      return rows
        .map((row) => toMemberView(row, known.get(row.userId)))
        .sort((a, b) => rank(a.role) - rank(b.role) || a.joinedAt - b.joinedAt);
    },

    updateGroup: async (conversationId: string, input: UpdateGroupInput): Promise<void> => {
      const title = input.title?.trim();
      if (title !== undefined && (title.length === 0 || title.length > 80)) {
        throw new Error('le nom du groupe doit faire entre 1 et 80 caractères');
      }

      const patch = {
        ...(title === undefined ? {} : { title }),
        ...(input.description === undefined ? {} : { description: input.description }),
        ...(input.restricted === undefined ? {} : { restricted: input.restricted }),
      };
      const payload: UpdateGroupPayload = { conversationId, ...patch };

      write('update_group', conversationId, conversationId, payload, (tx) => {
        tx.update(conversations).set(patch).where(eq(conversations.id, conversationId)).run();
      });
    },

    addMembers: async (conversationId: string, userIds: readonly string[]): Promise<void> => {
      if (userIds.length === 0) {
        return;
      }
      const at = now();
      const payload: AddMembersPayload = { conversationId, userIds: [...userIds] };

      write(
        'add_members',
        // La clé de déduplication porte les personnes : deux ajouts successifs
        // de gens différents ne doivent pas s'écraser l'un l'autre.
        `${conversationId}:${[...userIds].sort().join(',')}`,
        conversationId,
        payload,
        (tx) => {
          for (const userId of userIds) {
            tx.insert(conversationMembers)
              .values({ conversationId, userId, role: 'member', joinedAt: at })
              .onConflictDoNothing()
              .run();
          }
        },
      );
    },

    removeMember: async (conversationId: string, userId: string): Promise<void> => {
      const payload: MemberPayload = { conversationId, userId };

      write('remove_member', `${conversationId}:${userId}`, conversationId, payload, (tx) => {
        // Marqué plutôt que supprimé : une ligne effacée localement
        // réapparaîtrait à la première synchronisation si le serveur refuse, et
        // cela ressemblerait à un bug plutôt qu'à un refus.
        tx.update(conversationMembers)
          .set({ pendingRemoval: true })
          .where(
            and(
              eq(conversationMembers.conversationId, conversationId),
              eq(conversationMembers.userId, userId),
            ),
          )
          .run();
      });
    },

    setMemberRole: async (
      conversationId: string,
      userId: string,
      role: 'admin' | 'member',
    ): Promise<void> => {
      const payload: SetMemberRolePayload = { conversationId, userId, role };

      write('set_member_role', `${conversationId}:${userId}`, conversationId, payload, (tx) => {
        tx.update(conversationMembers)
          .set({ role })
          .where(
            and(
              eq(conversationMembers.conversationId, conversationId),
              eq(conversationMembers.userId, userId),
            ),
          )
          .run();
      });
    },

    transferOwnership: async (conversationId: string, userId: string): Promise<void> => {
      const payload: MemberPayload = { conversationId, userId };

      write('transfer_ownership', conversationId, conversationId, payload, (tx) => {
        // Les deux rôles changent ensemble, localement comme sur le serveur :
        // un état intermédiaire à deux propriétaires — ou à aucun — s'afficherait
        // le temps de la synchronisation.
        tx.update(conversationMembers)
          .set({ role: 'admin' })
          .where(
            and(
              eq(conversationMembers.conversationId, conversationId),
              eq(conversationMembers.role, 'owner'),
            ),
          )
          .run();

        tx.update(conversationMembers)
          .set({ role: 'owner' })
          .where(
            and(
              eq(conversationMembers.conversationId, conversationId),
              eq(conversationMembers.userId, userId),
            ),
          )
          .run();

        tx.update(conversations)
          .set({ ownerId: userId, myRole: 'admin' })
          .where(eq(conversations.id, conversationId))
          .run();
      });
    },

    leaveGroup: async (conversationId: string): Promise<void> => {
      const row = db.select().from(conversations).where(eq(conversations.id, conversationId)).get();

      // Le serveur refuserait de toute façon (#39). L'arrêter ici évite une
      // entrée en file vouée à l'échec définitif, et permet d'expliquer
      // pourquoi plutôt que d'afficher un échec d'envoi sans cause.
      if (row?.myRole === 'owner') {
        throw new Error('transférez la propriété avant de quitter le groupe');
      }

      const payload: LeaveGroupPayload = { conversationId };

      write('leave_group', conversationId, conversationId, payload, (tx) => {
        // L'historique reste lisible en local après le départ (#42) : on
        // archive, on ne supprime pas.
        tx.update(conversations)
          .set({ archivedAt: now() })
          .where(eq(conversations.id, conversationId))
          .run();
      });
    },

    setPrefs: async (conversationId: string, prefs: ConversationPrefs): Promise<void> => {
      const patch = {
        ...(prefs.mutedUntil === undefined ? {} : { mutedUntil: prefs.mutedUntil }),
        ...(prefs.pinnedAt === undefined ? {} : { pinnedAt: prefs.pinnedAt }),
        ...(prefs.archivedAt === undefined ? {} : { archivedAt: prefs.archivedAt }),
      };
      const payload: ConversationPrefsPayload = { conversationId, ...patch };

      // La sourdine vit côté serveur, pas seulement sur l'appareil : elle doit
      // s'appliquer à l'ENVOI de la notification (#58). Envoyer puis masquer
      // consommerait des données pour rien — précisément ce que l'utilisateur
      // cherchait à éviter en mettant le groupe en sourdine.
      write('set_conversation_prefs', conversationId, conversationId, payload, (tx) => {
        tx.update(conversations).set(patch).where(eq(conversations.id, conversationId)).run();
      });
    },

    createGroup: async (input: CreateGroupInput): Promise<ConversationView> => {
      const title = input.title.trim();
      if (title.length === 0 || title.length > 80) {
        throw new Error('le nom du groupe doit faire entre 1 et 80 caractères');
      }

      // L'identifiant est généré ICI, avant tout aller-retour réseau. C'est lui
      // que le serveur retiendra comme `client_id`, ce qui rend la création
      // idempotente — et surtout, c'est ce qui permet d'ouvrir l'écran du
      // groupe immédiatement, même sans réseau (#37, ADR-0002).
      const id = newId();
      const at = now();
      // Les membres ne sont pas écrits localement : le serveur filtre la liste
      // (profils inexistants, personnes ayant bloqué le créateur) et fait foi.
      // Les recopier ici afficherait une composition qui pourrait être fausse.
      const payload: CreateGroupPayload = {
        clientId: id,
        title,
        memberIds: [...input.memberIds],
        avatarUrl: input.avatarUrl ?? null,
      };

      const row = db.transaction((tx) => {
        const inserted = tx
          .insert(conversations)
          .values({
            id,
            type: 'group',
            title,
            avatarUrl: input.avatarUrl ?? null,
            createdAt: at,
            // Le groupe n'existe pas encore côté serveur. La colonne le dit
            // franchement plutôt que de laisser croire à une conversation
            // ordinaire dont les messages partiraient dans le vide.
            localOnly: true,
            // Il apparaît en tête de la liste tant qu'aucun message n'est
            // arrivé : un groupe qu'on vient de créer et qu'on ne retrouve pas
            // donne l'impression que la création a échoué.
            lastMessageAt: at,
          })
          .returning()
          .get();

        // Écriture métier et mise en file dans la MÊME transaction : une
        // création réussie avec une mise en file échouée produirait un groupe
        // qui ne partirait jamais, sans que rien ne le signale (ADR-0002).
        enqueue(tx, { operation: 'create_group', entityId: id, conversationId: id, payload }, at);
        return inserted;
      });

      emit();
      return toView(row);
    },

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
