import { sql } from 'drizzle-orm';
import {
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core';

/**
 * Schéma SQLite local — source de vérité de l'application (ADR-0002).
 *
 * Miroir du schéma Postgres de `supabase/migrations/`, avec trois différences
 * assumées :
 *
 *   1. des colonnes propres au client (`syncStatus`, `retryCount`, `localOnly`)
 *      qui n'existent pas côté serveur ;
 *   2. trois tables purement locales : `outbox`, `syncState` et `drafts` ;
 *   3. les horodatages sont des entiers (millisecondes epoch) plutôt que des
 *      `timestamptz` — SQLite n'a pas de type date, et un entier se compare et
 *      se trie sans conversion.
 *
 * Ce fichier n'importe rien d'`expo-sqlite` : il doit rester exécutable sous
 * Node pour que les tests puissent tourner sans React Native (#71).
 */

const now = sql`(unixepoch() * 1000)`;

// ---------------------------------------------------------------------------
// Miroir du schéma serveur
// ---------------------------------------------------------------------------

export const profiles = sqliteTable('profiles', {
  id: text('id').primaryKey(),
  username: text('username'),
  displayName: text('display_name'),
  avatarUrl: text('avatar_url'),
  phoneE164: text('phone_e164'),
  bio: text('bio'),
  lastSeenAt: integer('last_seen_at'),
  createdAt: integer('created_at').notNull().default(now),
});

export const conversations = sqliteTable(
  'conversations',
  {
    id: text('id').primaryKey(),
    type: text('type', { enum: ['dm', 'group', 'channel'] }).notNull(),
    title: text('title'),
    avatarUrl: text('avatar_url'),
    ownerId: text('owner_id'),
    communityId: text('community_id'),
    lastMessageAt: integer('last_message_at'),
    lastMessagePreview: text('last_message_preview'),
    lastMessageSenderId: text('last_message_sender_id'),
    lastMessageKind: text('last_message_kind', {
      enum: ['text', 'image', 'video', 'audio', 'file', 'system'],
    }),
    description: text('description'),
    /** Mode restreint : seuls les administrateurs écrivent (#39). */
    restricted: integer('restricted', { mode: 'boolean' }).notNull().default(false),
    /**
     * Rôle de l'utilisateur courant dans cette conversation.
     *
     * Recopié depuis `conversation_members` pour que l'interface sache quoi
     * proposer sans jointure, et surtout hors ligne. Il ne constitue jamais la
     * sécurité : elle est portée par RLS (#14, #39).
     */
    myRole: text('my_role', { enum: ['owner', 'admin', 'member'] })
      .notNull()
      .default('member'),
    lastSeq: integer('last_seq').notNull().default(0),
    createdAt: integer('created_at').notNull().default(now),

    // Réglages locaux, recopiés depuis `conversation_members` pour éviter une
    // jointure sur le chemin de la liste des conversations.
    lastReadSeq: integer('last_read_seq').notNull().default(0),
    mutedUntil: integer('muted_until'),
    pinnedAt: integer('pinned_at'),
    archivedAt: integer('archived_at'),

    /**
     * Date d'ouverture de l'écran de conversation, purement locale. Sert à
     * ordonner la synchronisation (#53) : un groupe bavard qu'on ne lit jamais
     * ne doit pas passer devant le fil consulté tous les jours.
     */
    lastOpenedAt: integer('last_opened_at'),

    /** La conversation n'existe pas encore côté serveur (créée hors ligne). */
    localOnly: integer('local_only', { mode: 'boolean' }).notNull().default(false),
  },
  (table) => [
    // Le tri de la liste des conversations, l'écran le plus consulté.
    index('conversations_last_message_at_idx').on(table.lastMessageAt),
    // L'ordre de priorité de la synchronisation delta.
    index('conversations_last_opened_at_idx').on(table.lastOpenedAt),
  ],
);

export const conversationMembers = sqliteTable(
  'conversation_members',
  {
    conversationId: text('conversation_id').notNull(),
    userId: text('user_id').notNull(),
    role: text('role', { enum: ['owner', 'admin', 'member'] })
      .notNull()
      .default('member'),
    lastReadSeq: integer('last_read_seq').notNull().default(0),
    joinedAt: integer('joined_at').notNull().default(now),
    /** Retiré localement en attendant la confirmation du serveur. */
    pendingRemoval: integer('pending_removal', { mode: 'boolean' }).notNull().default(false),
  },
  (table) => [
    primaryKey({ columns: [table.conversationId, table.userId] }),
    index('conversation_members_user_id_idx').on(table.userId),
  ],
);

export const messages = sqliteTable(
  'messages',
  {
    /**
     * Généré sur l'appareil AVANT tout aller-retour réseau. C'est la clé
     * primaire locale, et c'est ce qui rend l'envoi idempotent : le serveur
     * porte la même valeur en contrainte unique.
     */
    clientId: text('client_id').primaryKey(),

    /** Identifiant serveur. Nul tant que le message n'est pas parti. */
    id: text('id'),

    conversationId: text('conversation_id').notNull(),
    senderId: text('sender_id'),

    /**
     * Nul tant que le serveur ne l'a pas attribué. Un message en attente est
     * donc trié par `createdAt`, après tous les messages qui ont un seq.
     */
    seq: integer('seq'),

    kind: text('kind', { enum: ['text', 'image', 'video', 'audio', 'file', 'system'] })
      .notNull()
      .default('text'),
    body: text('body'),
    replyToId: text('reply_to_id'),
    editedAt: integer('edited_at'),
    deletedAt: integer('deleted_at'),
    createdAt: integer('created_at').notNull().default(now),

    // --- colonnes propres au client ---
    syncStatus: text('sync_status', { enum: ['pending', 'sent', 'failed'] })
      .notNull()
      .default('pending'),
    /** Masqué localement (« supprimer pour moi »), sans effet pour les autres. */
    hiddenLocally: integer('hidden_locally', { mode: 'boolean' }).notNull().default(false),
  },
  (table) => [
    // Le chemin de lecture d'une page de conversation.
    index('messages_conversation_seq_idx').on(table.conversationId, table.seq),
    // Les messages en attente, triés par date : ce sont ceux sans seq.
    index('messages_conversation_created_idx').on(table.conversationId, table.createdAt),
    index('messages_sync_status_idx').on(table.syncStatus),
    uniqueIndex('messages_server_id_idx').on(table.id),
  ],
);

export const attachments = sqliteTable(
  'attachments',
  {
    id: text('id').primaryKey(),
    messageClientId: text('message_client_id').notNull(),
    storagePath: text('storage_path'),
    /** Chemin du fichier sur l'appareil, conservé jusqu'à confirmation d'envoi. */
    localUri: text('local_uri'),
    mime: text('mime').notNull(),
    size: integer('size').notNull(),
    width: integer('width'),
    height: integer('height'),
    durationMs: integer('duration_ms'),
    blurhash: text('blurhash'),
  },
  (table) => [index('attachments_message_idx').on(table.messageClientId)],
);

export const reactions = sqliteTable(
  'reactions',
  {
    messageClientId: text('message_client_id').notNull(),
    userId: text('user_id').notNull(),
    emoji: text('emoji').notNull(),
    createdAt: integer('created_at').notNull().default(now),
    syncStatus: text('sync_status', { enum: ['pending', 'sent', 'failed'] })
      .notNull()
      .default('pending'),
  },
  (table) => [primaryKey({ columns: [table.messageClientId, table.userId, table.emoji] })],
);

export const receipts = sqliteTable(
  'receipts',
  {
    messageClientId: text('message_client_id').notNull(),
    userId: text('user_id').notNull(),
    deliveredAt: integer('delivered_at'),
    readAt: integer('read_at'),
  },
  (table) => [primaryKey({ columns: [table.messageClientId, table.userId] })],
);

// ---------------------------------------------------------------------------
// Tables purement locales
// ---------------------------------------------------------------------------

/**
 * File d'attente sortante.
 *
 * Toute écriture passe ici, dans la MÊME transaction que l'écriture métier :
 * une insertion réussie avec une mise en file échouée produirait un message qui
 * ne partirait jamais, sans que rien ne le signale (ADR-0002).
 */
export const outbox = sqliteTable(
  'outbox',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),

    /** `send_message`, `edit_message`, `delete_message`, `add_reaction`… */
    operation: text('operation').notNull(),

    /**
     * Clé de déduplication. Deux entrées de même clé pour une même opération ne
     * doivent pas coexister : réémettre est sûr, empiler ne l'est pas.
     */
    entityId: text('entity_id').notNull(),

    /** Sert à préserver l'ordre d'envoi au sein d'une conversation. */
    conversationId: text('conversation_id'),

    /** Charge utile sérialisée en JSON. */
    payload: text('payload').notNull(),

    retryCount: integer('retry_count').notNull().default(0),
    /** Date de la prochaine tentative : porte la temporisation exponentielle. */
    nextAttemptAt: integer('next_attempt_at').notNull().default(now),
    lastError: text('last_error'),
    createdAt: integer('created_at').notNull().default(now),
  },
  (table) => [
    uniqueIndex('outbox_operation_entity_idx').on(table.operation, table.entityId),
    // Le tri de traitement : par éligibilité, puis par ordre d'insertion.
    index('outbox_next_attempt_idx').on(table.nextAttemptAt, table.id),
  ],
);

/**
 * Curseur de synchronisation par conversation.
 *
 * La reprise après coupure est un `where seq > cursor`, jamais un rechargement
 * complet. Le curseur n'avance qu'APRÈS écriture locale confirmée.
 */
export const syncState = sqliteTable('sync_state', {
  conversationId: text('conversation_id').primaryKey(),
  /**
   * Ancien curseur, sur `seq`. Conservé sans être lu : les migrations locales
   * sont strictement additives. Il ne rattrapait pas les messages modifiés ou
   * supprimés après leur émission — voir `lastChangeSeq`.
   */
  lastSyncedSeq: integer('last_synced_seq').notNull().default(0),
  /**
   * Le curseur de la synchronisation delta (#53). Il n'avance qu'APRÈS
   * l'écriture locale de la page, dans la même transaction : l'avancer avant
   * perdrait définitivement les messages de la page en cas de coupure.
   */
  lastChangeSeq: integer('last_change_seq').notNull().default(0),
  lastSyncedAt: integer('last_synced_at'),
  /** Date de la dernière remise à zéro forcée du curseur. Rare, et anormale. */
  resetAt: integer('reset_at'),
});

/** Brouillon par conversation, restauré à la réouverture (#31). */
export const drafts = sqliteTable('drafts', {
  conversationId: text('conversation_id').primaryKey(),
  body: text('body').notNull(),
  replyToId: text('reply_to_id'),
  updatedAt: integer('updated_at').notNull().default(now),
});

// ---------------------------------------------------------------------------
// Types inférés
// ---------------------------------------------------------------------------

export type LocalMessage = typeof messages.$inferSelect;
export type NewLocalMessage = typeof messages.$inferInsert;
export type LocalConversation = typeof conversations.$inferSelect;
export type NewLocalConversation = typeof conversations.$inferInsert;
export type OutboxEntry = typeof outbox.$inferSelect;
export type NewOutboxEntry = typeof outbox.$inferInsert;
export type LocalDraft = typeof drafts.$inferSelect;
export type LocalMember = typeof conversationMembers.$inferSelect;
