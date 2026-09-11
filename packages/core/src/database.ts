import type { Database } from './database.types';

/**
 * Alias lisibles sur les types générés.
 *
 * `database.types.ts` est produit par `pnpm db:types` depuis le schéma Postgres,
 * jamais écrit à la main. Il est volumineux et pénible à parcourir : ce fichier
 * lui donne des noms utilisables, et c'est lui qu'on importe.
 *
 * L'intérêt de générer plutôt que de recopier : une colonne renommée casse la
 * compilation, au lieu de casser l'application en production.
 */

export type { Database, Json } from './database.types';

type Public = Database['public'];
type TableRow<T extends keyof Public['Tables']> = Public['Tables'][T]['Row'];
type TableInsert<T extends keyof Public['Tables']> = Public['Tables'][T]['Insert'];
type TableUpdate<T extends keyof Public['Tables']> = Public['Tables'][T]['Update'];

// ---------------------------------------------------------------------------
// Lignes
// ---------------------------------------------------------------------------

export type Profile = TableRow<'profiles'>;
export type Device = TableRow<'devices'>;
export type Conversation = TableRow<'conversations'>;
export type ConversationMember = TableRow<'conversation_members'>;
export type Message = TableRow<'messages'>;
export type Attachment = TableRow<'attachments'>;
export type Reaction = TableRow<'reactions'>;
export type Receipt = TableRow<'receipts'>;
export type Contact = TableRow<'contacts'>;
export type Block = TableRow<'blocks'>;
export type Report = TableRow<'reports'>;

/** Vue de la liste des conversations, non-lus inclus (#15, #29). */
export type ConversationOverview = Public['Views']['conversation_overview']['Row'];

// ---------------------------------------------------------------------------
// Insertions et mises à jour
// ---------------------------------------------------------------------------

export type ProfileInsert = TableInsert<'profiles'>;
export type ProfileUpdate = TableUpdate<'profiles'>;
export type DeviceInsert = TableInsert<'devices'>;
export type ConversationInsert = TableInsert<'conversations'>;
export type ConversationMemberInsert = TableInsert<'conversation_members'>;
export type MessageInsert = TableInsert<'messages'>;
export type MessageUpdate = TableUpdate<'messages'>;
export type AttachmentInsert = TableInsert<'attachments'>;
export type ReactionInsert = TableInsert<'reactions'>;
export type ReceiptInsert = TableInsert<'receipts'>;
export type ReportInsert = TableInsert<'reports'>;

// ---------------------------------------------------------------------------
// Énumérations
// ---------------------------------------------------------------------------
//
// Ces types viennent du schéma, contrairement à leurs homonymes déclarés à la
// main dans `types.ts`. La garde ci-dessous vérifie que les deux ne divergent
// pas : si un `alter type` ajoute une valeur côté serveur sans que `types.ts`
// suive, la compilation échoue au lieu de laisser le client ignorer un cas.

export type DbConversationType = Public['Enums']['conversation_type'];
export type DbMemberRole = Public['Enums']['member_role'];
export type DbMessageKind = Public['Enums']['message_kind'];
export type DbReportStatus = Public['Enums']['report_status'];
export type DbReportTarget = Public['Enums']['report_target'];
export type DbContactSource = Public['Enums']['contact_source'];
