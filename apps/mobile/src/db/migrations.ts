/**
 * Migrations de la base locale.
 *
 * Elles s'exécutent sur l'appareil d'un utilisateur, sans possibilité de retour
 * arrière : une migration ratée laisse une base cassée que personne ne peut
 * réparer à distance. Deux règles en découlent.
 *
 *   1. **Strictement additives.** On ajoute des tables, des colonnes et des
 *      index. On ne renomme pas, on ne supprime pas, on ne change pas un type.
 *      Une colonne devenue inutile est laissée en place.
 *
 *   2. **Atomiques.** Chaque migration s'exécute dans une transaction avec
 *      l'avancement de `user_version`. Une interruption — l'utilisateur tue
 *      l'application, la batterie lâche — annule tout et la migration sera
 *      rejouée au prochain démarrage.
 *
 * `user_version` est un entier stocké dans l'en-tête du fichier SQLite. Il ne
 * coûte aucune table de suivi et survit à tout, y compris à une copie du
 * fichier.
 */

export interface LocalMigration {
  readonly version: number;
  readonly name: string;
  readonly statements: readonly string[];
}

export const LOCAL_MIGRATIONS: readonly LocalMigration[] = [
  {
    version: 1,
    name: 'schéma initial',
    statements: [
      `create table if not exists profiles (
         id            text primary key not null,
         username      text,
         display_name  text,
         avatar_url    text,
         phone_e164    text,
         bio           text,
         last_seen_at  integer,
         created_at    integer not null default (unixepoch() * 1000)
       )`,

      `create table if not exists conversations (
         id                      text primary key not null,
         type                    text not null,
         title                   text,
         avatar_url              text,
         owner_id                text,
         community_id            text,
         last_message_at         integer,
         last_message_preview    text,
         last_message_sender_id  text,
         last_seq                integer not null default 0,
         created_at              integer not null default (unixepoch() * 1000),
         last_read_seq           integer not null default 0,
         muted_until             integer,
         pinned_at               integer,
         archived_at             integer,
         local_only              integer not null default 0
       )`,
      `create index if not exists conversations_last_message_at_idx
         on conversations (last_message_at)`,

      `create table if not exists conversation_members (
         conversation_id text not null,
         user_id         text not null,
         role            text not null default 'member',
         last_read_seq   integer not null default 0,
         joined_at       integer not null default (unixepoch() * 1000),
         primary key (conversation_id, user_id)
       )`,
      `create index if not exists conversation_members_user_id_idx
         on conversation_members (user_id)`,

      `create table if not exists messages (
         client_id       text primary key not null,
         id              text,
         conversation_id text not null,
         sender_id       text,
         seq             integer,
         kind            text not null default 'text',
         body            text,
         reply_to_id     text,
         edited_at       integer,
         deleted_at      integer,
         created_at      integer not null default (unixepoch() * 1000),
         sync_status     text not null default 'pending',
         hidden_locally  integer not null default 0
       )`,
      // Le chemin de lecture d'une page de conversation (#30).
      `create index if not exists messages_conversation_seq_idx
         on messages (conversation_id, seq)`,
      // Les messages en attente n'ont pas encore de seq : ils se trient par date.
      `create index if not exists messages_conversation_created_idx
         on messages (conversation_id, created_at)`,
      `create index if not exists messages_sync_status_idx
         on messages (sync_status)`,
      // Partiel : plusieurs messages en attente ont un id serveur nul, et SQLite
      // considère chaque NULL comme distinct — mais on borne quand même l'index.
      `create unique index if not exists messages_server_id_idx
         on messages (id) where id is not null`,

      `create table if not exists attachments (
         id                text primary key not null,
         message_client_id text not null,
         storage_path      text,
         local_uri         text,
         mime              text not null,
         size              integer not null,
         width             integer,
         height            integer,
         duration_ms       integer,
         blurhash          text
       )`,
      `create index if not exists attachments_message_idx
         on attachments (message_client_id)`,

      `create table if not exists reactions (
         message_client_id text not null,
         user_id           text not null,
         emoji             text not null,
         created_at        integer not null default (unixepoch() * 1000),
         sync_status       text not null default 'pending',
         primary key (message_client_id, user_id, emoji)
       )`,

      `create table if not exists receipts (
         message_client_id text not null,
         user_id           text not null,
         delivered_at      integer,
         read_at           integer,
         primary key (message_client_id, user_id)
       )`,

      `create table if not exists outbox (
         id              integer primary key autoincrement,
         operation       text not null,
         entity_id       text not null,
         conversation_id text,
         payload         text not null,
         retry_count     integer not null default 0,
         next_attempt_at integer not null default (unixepoch() * 1000),
         last_error      text,
         created_at      integer not null default (unixepoch() * 1000)
       )`,
      // Réémettre est sûr, empiler ne l'est pas : une seule entrée par couple
      // (opération, entité).
      `create unique index if not exists outbox_operation_entity_idx
         on outbox (operation, entity_id)`,
      `create index if not exists outbox_next_attempt_idx
         on outbox (next_attempt_at, id)`,

      `create table if not exists sync_state (
         conversation_id  text primary key not null,
         last_synced_seq  integer not null default 0,
         last_synced_at   integer
       )`,

      `create table if not exists drafts (
         conversation_id text primary key not null,
         body            text not null,
         reply_to_id     text,
         updated_at      integer not null default (unixepoch() * 1000)
       )`,
    ],
  },
  {
    version: 2,
    name: 'type du dernier message',
    statements: [
      // Le serveur porte déjà `last_message_kind` : sans son équivalent local,
      // la liste des conversations ne peut pas afficher « Photo » ou « Message
      // vocal » à la place d'un aperçu vide (#29).
      `alter table conversations add column last_message_kind text`,
    ],
  },
  {
    version: 3,
    name: 'curseur de synchronisation delta',
    statements: [
      // `last_synced_seq` portait le curseur sur `seq`. Il ne rattrape pas les
      // messages modifiés ou supprimés après leur émission : leur seq ne bouge
      // pas, donc un curseur qui les a dépassés ne les reverra jamais. Le
      // serveur porte désormais une suite d'écritures distincte (migration
      // 20260910120012), et c'est elle qu'on suit.
      //
      // L'ancienne colonne est laissée en place : les migrations locales sont
      // strictement additives, on ne supprime pas une colonne sur l'appareil
      // d'un utilisateur.
      `alter table sync_state add column last_change_seq integer not null default 0`,

      // Un curseur remis à zéro doit être distinguable d'un curseur jamais
      // utilisé : sans cela, une reprise après incohérence ressemblerait à une
      // première synchronisation et le rapport mentirait.
      `alter table sync_state add column reset_at integer`,

      // « Priorité aux conversations récemment consultées » (#53). C'est la
      // date d'OUVERTURE de l'écran, pas celle du dernier message : un groupe
      // bavard qu'on ne lit jamais ne doit pas passer devant le fil qu'on
      // consulte tous les jours.
      `alter table conversations add column last_opened_at integer`,
      `create index if not exists conversations_last_opened_at_idx
         on conversations (last_opened_at)`,
    ],
  },
  {
    version: 4,
    name: 'rôles et réglages de groupe',
    statements: [
      `alter table conversations add column description text`,
      `alter table conversations add column restricted integer not null default 0`,
      // Le rôle de l'utilisateur courant, recopié pour que l'écran d'infos
      // sache quoi proposer sans jointure et surtout hors ligne (#38, #39).
      `alter table conversations add column my_role text not null default 'member'`,
      // Un retrait posé hors ligne : la ligne reste, marquée, jusqu'à ce que le
      // serveur confirme. La supprimer tout de suite la ferait réapparaître à
      // la première synchronisation, ce qui ressemblerait à un bug.
      `alter table conversation_members add column pending_removal integer not null default 0`,
    ],
  },
];

/** Version cible de la base, déduite de la dernière migration déclarée. */
export const TARGET_SCHEMA_VERSION = LOCAL_MIGRATIONS.reduce(
  (max, migration) => Math.max(max, migration.version),
  0,
);
