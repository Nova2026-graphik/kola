import type { MessageKind } from './types';

/**
 * Contrat du transport de la file d'attente sortante.
 *
 * Le moteur qui vide la file ne connaît pas Supabase : il ne connaît que cette
 * interface. Deux raisons, et la seconde compte davantage que la première.
 *
 *   1. Le jour où le transport change — une Edge Function plutôt que PostgREST,
 *      ou un tout autre backend — le moteur ne bouge pas.
 *   2. Surtout, le moteur devient testable sans réseau. Or c'est le composant
 *      dont les bugs sont les plus coûteux et les plus difficiles à reproduire :
 *      ils n'apparaissent qu'après une coupure au mauvais moment, chez un
 *      utilisateur, sans trace exploitable (ADR-0002).
 */

// ---------------------------------------------------------------------------
// Charges utiles — telles qu'elles sont sérialisées dans la file
// ---------------------------------------------------------------------------

export interface SendMessagePayload {
  readonly clientId: string;
  readonly conversationId: string;
  readonly senderId: string;
  readonly kind: MessageKind;
  readonly body: string | null;
  readonly replyToId: string | null;
}

export interface EditMessagePayload {
  readonly clientId: string;
  readonly messageId: string;
  readonly body: string;
}

export interface DeleteMessagePayload {
  readonly clientId: string;
  readonly messageId: string;
}

export interface MarkReadPayload {
  readonly conversationId: string;
  readonly upToSeq: number;
}

export interface ReactionPayload {
  readonly messageId: string;
  readonly emoji: string;
}

/** Ce que le serveur attribue à un message : c'est lui qui fait foi. */
export interface SendMessageResult {
  readonly id: string;
  readonly seq: number;
}

export interface OutboxTransport {
  readonly sendMessage: (payload: SendMessagePayload) => Promise<SendMessageResult>;
  readonly editMessage: (payload: EditMessagePayload) => Promise<void>;
  readonly deleteMessage: (payload: DeleteMessagePayload) => Promise<void>;
  readonly markRead: (payload: MarkReadPayload) => Promise<void>;
  readonly addReaction: (payload: ReactionPayload) => Promise<void>;
  readonly removeReaction: (payload: ReactionPayload) => Promise<void>;
}

// ---------------------------------------------------------------------------
// Erreurs
// ---------------------------------------------------------------------------

/**
 * Erreur de transport portant un code HTTP.
 *
 * Le code décide de tout : réessayer indéfiniment un refus RLS épuise la
 * batterie et le forfait sans jamais aboutir, tandis qu'abandonner sur une
 * coupure réseau perdrait un message que l'utilisateur croit envoyé.
 * Voir `isPermanentFailure`.
 */
export class TransportError extends Error {
  readonly status: number | null;

  constructor(message: string, status: number | null = null, options?: ErrorOptions) {
    super(message, options);
    this.name = 'TransportError';
    this.status = status;
  }
}

/**
 * Le serveur a rejeté un envoi parce que ce `client_id` existe déjà.
 *
 * Ce n'est pas une erreur : c'est l'idempotence qui fonctionne. Le message
 * était bien parti, seule la réponse s'est perdue — le cas typique d'une
 * coupure juste après l'envoi. Le moteur doit traiter l'entrée comme réussie.
 */
export class DuplicateMessageError extends TransportError {
  readonly existing: SendMessageResult;

  constructor(existing: SendMessageResult) {
    super('message déjà reçu par le serveur', 409);
    this.name = 'DuplicateMessageError';
    this.existing = existing;
  }
}

// ---------------------------------------------------------------------------
// Rapport d'exécution
// ---------------------------------------------------------------------------

export interface OutboxRunReport {
  /** Entrées envoyées avec succès. */
  readonly sent: number;
  /** Entrées ayant échoué de façon transitoire : elles seront réessayées. */
  readonly deferred: number;
  /** Entrées abandonnées : erreur définitive ou tentatives épuisées. */
  readonly abandoned: number;
  /** Entrées non tentées parce qu'une précédente bloquait leur conversation. */
  readonly blocked: number;
}

export const EMPTY_RUN_REPORT: OutboxRunReport = {
  sent: 0,
  deferred: 0,
  abandoned: 0,
  blocked: 0,
};
