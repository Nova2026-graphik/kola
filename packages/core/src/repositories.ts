import type { ConversationType, MessageKind, SyncStatus } from './types';

/**
 * Contrats des repositories.
 *
 * Le repository est le SEUL point de passage vers les données. C'est ce qui
 * matérialise le local-first et empêche le reste du code d'y déroger : si un
 * écran peut appeler Supabase directement, l'architecture se délite en quelques
 * semaines (ADR-0002).
 *
 * Deux invariants portés par ces contrats :
 *
 *   * **la lecture est locale**. Aucune méthode `get*` ni `list*` ne déclenche
 *     de requête réseau, jamais, même si le réseau est disponible ;
 *   * **l'écriture est locale puis mise en file**. Les deux dans la même
 *     transaction : une écriture réussie sans mise en file produirait un
 *     message qui ne partirait jamais.
 */

// ---------------------------------------------------------------------------
// Modèles de lecture
// ---------------------------------------------------------------------------

export interface MessageView {
  readonly clientId: string;
  readonly id: string | null;
  readonly conversationId: string;
  readonly senderId: string | null;
  readonly seq: number | null;
  readonly kind: MessageKind;
  readonly body: string | null;
  readonly replyToId: string | null;
  readonly editedAt: number | null;
  readonly deletedAt: number | null;
  readonly createdAt: number;
  readonly syncStatus: SyncStatus;
}

export interface ConversationView {
  readonly id: string;
  readonly type: ConversationType;
  readonly title: string | null;
  readonly avatarUrl: string | null;
  readonly lastMessageAt: number | null;
  readonly lastMessagePreview: string | null;
  readonly lastMessageSenderId: string | null;
  /** Type du dernier message : décide du libellé quand il n'y a pas de texte. */
  readonly lastMessageKind: MessageKind | null;
  readonly lastSeq: number;
  readonly lastReadSeq: number;
  readonly unreadCount: number;
  readonly mutedUntil: number | null;
  readonly pinnedAt: number | null;
  readonly archivedAt: number | null;
}

// ---------------------------------------------------------------------------
// Entrées d'écriture
// ---------------------------------------------------------------------------

export interface SendMessageInput {
  readonly conversationId: string;
  readonly senderId: string;
  readonly body: string;
  readonly kind?: MessageKind;
  readonly replyToId?: string | null;
  /**
   * Normalement omis : le repository génère l'identifiant. Ne l'imposer que
   * dans les tests, où le déterminisme compte.
   */
  readonly clientId?: string;
  /**
   * Efface le brouillon de la conversation, dans la même transaction.
   *
   * L'atomicité n'est pas un détail : un plantage entre l'insertion et
   * l'effacement laisserait le brouillon en place, et l'utilisateur
   * réenverrait un message déjà parti.
   */
  readonly clearDraft?: boolean;
}

/** Pagination par curseur `seq` décroissant. Jamais de `offset`. */
export interface MessagePageQuery {
  readonly conversationId: string;
  /** Retourne les messages strictement antérieurs à ce seq. */
  readonly beforeSeq?: number | null;
  readonly limit?: number;
}

export type Unsubscribe = () => void;

// ---------------------------------------------------------------------------
// Contrats
// ---------------------------------------------------------------------------

export interface MessageRepository {
  /** Lecture locale. Ne déclenche aucune requête réseau. */
  readonly getMessages: (query: MessagePageQuery) => Promise<readonly MessageView[]>;
  readonly getMessage: (clientId: string) => Promise<MessageView | null>;

  /**
   * Insère le message localement avec le statut `pending` et le met en file,
   * dans une seule transaction. Retourne immédiatement : l'interface affiche
   * le message avant tout aller-retour réseau.
   */
  readonly sendMessage: (input: SendMessageInput) => Promise<MessageView>;

  readonly editMessage: (clientId: string, body: string) => Promise<MessageView>;

  /** `forEveryone: false` masque le message localement, sans effet pour les autres. */
  readonly deleteMessage: (clientId: string, forEveryone: boolean) => Promise<void>;

  /** Remet en file un message en échec. Ne crée jamais de doublon. */
  readonly retryMessage: (clientId: string) => Promise<void>;

  /** Retire définitivement un message en échec, file comprise. */
  readonly discardMessage: (clientId: string) => Promise<void>;

  /**
   * Notifie à chaque modification locale de la conversation.
   * Granulaire par conversation : sans cela, chaque message reçu re-rendrait
   * toute la liste.
   */
  readonly subscribe: (conversationId: string, listener: () => void) => Unsubscribe;
}

export interface ConversationRepository {
  readonly listConversations: () => Promise<readonly ConversationView[]>;
  readonly getConversation: (id: string) => Promise<ConversationView | null>;
  /** Avance le curseur de lecture. Monotone : ne recule jamais. */
  readonly markRead: (conversationId: string, upToSeq: number) => Promise<void>;
  readonly subscribe: (listener: () => void) => Unsubscribe;
}

// ---------------------------------------------------------------------------
// File d'attente sortante
// ---------------------------------------------------------------------------

export type OutboxOperation =
  | 'send_message'
  | 'edit_message'
  | 'delete_message'
  | 'add_reaction'
  | 'remove_reaction'
  | 'mark_read';

export interface OutboxItem {
  readonly id: number;
  readonly operation: OutboxOperation;
  readonly entityId: string;
  readonly conversationId: string | null;
  readonly payload: unknown;
  readonly retryCount: number;
  readonly nextAttemptAt: number;
  readonly lastError: string | null;
  readonly createdAt: number;
}

/**
 * Temporisation exponentielle, plafonnée, avec part d'aléatoire.
 *
 * L'aléatoire n'est pas cosmétique : sans lui, tous les clients d'une même zone
 * se reconnectent à la même seconde après un rétablissement de réseau et
 * refont converger la charge.
 */
export const OUTBOX_BACKOFF = {
  baseMs: 1_000,
  maxMs: 300_000,
  jitterRatio: 0.25,
  maxRetries: 8,
} as const;

export function computeBackoffMs(retryCount: number, random: () => number = Math.random): number {
  const exponential = Math.min(OUTBOX_BACKOFF.baseMs * 2 ** retryCount, OUTBOX_BACKOFF.maxMs);
  const jitter = exponential * OUTBOX_BACKOFF.jitterRatio * (random() * 2 - 1);
  return Math.max(0, Math.round(exponential + jitter));
}

/**
 * Une erreur définitive ne se réessaie pas.
 *
 * Réessayer indéfiniment un refus RLS épuise la batterie et le forfait sans
 * jamais aboutir. Les 4xx s'abandonnent, les 5xx et les erreurs réseau se
 * réessaient.
 */
export function isPermanentFailure(status: number | null | undefined): boolean {
  if (status === null || status === undefined) {
    // Pas de réponse du tout : coupure réseau, donc transitoire.
    return false;
  }
  // 408 et 429 sont des 4xx, mais demandent explicitement de réessayer.
  if (status === 408 || status === 429) {
    return false;
  }
  return status >= 400 && status < 500;
}
