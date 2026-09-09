import type { SUPPORTED_LOCALES } from './constants.js';

/** Langue d'interface supportée. */
export type Locale = (typeof SUPPORTED_LOCALES)[number];

/** Les trois formes de conversation partagent un seul modèle de données. */
export type ConversationType = 'dm' | 'group' | 'channel';

/** Rôle d'un membre au sein d'une conversation. */
export type MemberRole = 'owner' | 'admin' | 'member';

/** Nature d'un message. `system` est généré par le serveur, jamais par un client. */
export type MessageKind = 'text' | 'image' | 'video' | 'audio' | 'file' | 'system';

/**
 * État de synchronisation d'une écriture locale.
 * Colonne propre au client : elle n'existe pas côté serveur.
 */
export type SyncStatus = 'pending' | 'sent' | 'failed';

/**
 * Identifiant généré sur l'appareil avant tout aller-retour réseau.
 * C'est lui qui rend l'envoi idempotent : une réémission après expiration de délai
 * est rejetée par la contrainte d'unicité côté serveur plutôt que dupliquée.
 */
export type ClientId = string;

/**
 * Curseur de synchronisation d'une conversation.
 * La reprise après coupure est un `where seq > cursor`, jamais un rechargement complet.
 */
export interface SyncCursor {
  conversationId: string;
  seq: number;
}
