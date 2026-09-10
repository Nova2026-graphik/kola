import type { Unsubscribe } from './repositories';
import type { MemberRole, MessageKind } from './types';

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
  /**
   * Exigé par la policy RLS de `reactions` : on ne réagit que sous sa propre
   * identité (#14). Le serveur refuserait une insertion signée d'un autre.
   */
  readonly userId: string;
}

/** Ce que le serveur attribue à un message : c'est lui qui fait foi. */
export interface SendMessageResult {
  readonly id: string;
  readonly seq: number;
}

// ---------------------------------------------------------------------------
// Création de groupe
// ---------------------------------------------------------------------------

export interface CreateGroupPayload {
  /** Généré sur l'appareil. C'est lui qui rend la création idempotente (#37). */
  readonly clientId: string;
  readonly title: string;
  readonly memberIds: readonly string[];
  readonly avatarUrl: string | null;
}

/** Ce que le serveur attribue au groupe créé. */
export interface CreateGroupResult {
  readonly id: string;
}

// ---------------------------------------------------------------------------
// Administration d'un groupe (#38, #39, #42)
// ---------------------------------------------------------------------------

export interface UpdateGroupPayload {
  readonly conversationId: string;
  readonly title?: string;
  readonly description?: string | null;
  readonly avatarUrl?: string | null;
  readonly restricted?: boolean;
}

export interface AddMembersPayload {
  readonly conversationId: string;
  readonly userIds: readonly string[];
}

export interface MemberPayload {
  readonly conversationId: string;
  readonly userId: string;
}

export interface SetMemberRolePayload extends MemberPayload {
  /** `owner` est impossible ici : la propriété se transfère (#39). */
  readonly role: 'admin' | 'member';
}

export interface LeaveGroupPayload {
  readonly conversationId: string;
}

/**
 * Réglages par conversation.
 *
 * Ils vivent côté serveur et non seulement sur l'appareil : la sourdine doit
 * s'appliquer à l'ENVOI de la notification (#58), pas seulement à son
 * affichage. Envoyer une notification pour la masquer ensuite consommerait des
 * données pour rien — ce qui est précisément ce que l'utilisateur cherchait à
 * éviter en la mettant en sourdine.
 */
export interface ConversationPrefsPayload {
  readonly conversationId: string;
  readonly mutedUntil?: number | null;
  readonly pinnedAt?: number | null;
  readonly archivedAt?: number | null;
}

export interface OutboxTransport {
  readonly sendMessage: (payload: SendMessagePayload) => Promise<SendMessageResult>;
  readonly createGroup: (payload: CreateGroupPayload) => Promise<CreateGroupResult>;
  readonly updateGroup: (payload: UpdateGroupPayload) => Promise<void>;
  readonly addMembers: (payload: AddMembersPayload) => Promise<void>;
  readonly removeMember: (payload: MemberPayload) => Promise<void>;
  readonly setMemberRole: (payload: SetMemberRolePayload) => Promise<void>;
  readonly transferOwnership: (payload: MemberPayload) => Promise<void>;
  readonly leaveGroup: (payload: LeaveGroupPayload) => Promise<void>;
  readonly setConversationPrefs: (payload: ConversationPrefsPayload) => Promise<void>;
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

// ---------------------------------------------------------------------------
// Synchronisation entrante — le pendant de la file d'attente sortante
// ---------------------------------------------------------------------------

/**
 * Contrat du transport de la synchronisation delta (#53).
 *
 * Séparé d'`OutboxTransport` à dessein : les deux sens n'ont ni les mêmes
 * échecs ni la même urgence. Un envoi qui échoue laisse un message que
 * l'utilisateur croit parti ; une réception qui échoue laisse simplement
 * l'appareil en retard, et la passe suivante rattrapera. Les mélanger ferait
 * traiter le second cas avec la gravité du premier.
 */

/** Un message tel que le serveur le rend. Les dates sont en millisecondes. */
export interface RemoteMessage {
  readonly id: string;
  readonly clientId: string;
  readonly conversationId: string;
  readonly senderId: string | null;
  readonly seq: number;
  /** Rang de la dernière écriture. C'est lui qui porte le curseur. */
  readonly changeSeq: number;
  readonly kind: MessageKind;
  readonly body: string | null;
  readonly replyToId: string | null;
  readonly editedAt: number | null;
  readonly deletedAt: number | null;
  readonly createdAt: number;
}

/** Une conversation telle que `conversation_overview` la rend. */
export interface RemoteConversation {
  readonly id: string;
  readonly type: 'dm' | 'group' | 'channel';
  readonly title: string | null;
  readonly avatarUrl: string | null;
  readonly ownerId: string | null;
  readonly communityId: string | null;
  readonly lastMessageAt: number | null;
  readonly lastMessagePreview: string | null;
  readonly lastMessageSenderId: string | null;
  readonly lastMessageKind: MessageKind | null;
  readonly lastSeq: number;
  /**
   * Compteur d'écritures du serveur. Sert au client à repérer un curseur
   * incohérent : si le sien est en avance, c'est que la base a été restaurée
   * depuis une sauvegarde et qu'il attend des lignes qui ne viendront jamais.
   */
  readonly lastChangeSeq: number;
  readonly lastReadSeq: number;
  readonly mutedUntil: number | null;
  readonly pinnedAt: number | null;
  readonly archivedAt: number | null;
  readonly createdAt: number;
}

export interface MessagePageQueryRemote {
  readonly conversationId: string;
  /** Curseur : on ne veut que ce qui a changé APRÈS cette valeur. */
  readonly afterChangeSeq: number;
  readonly limit: number;
}

export interface SyncTransport {
  /** La liste des conversations de l'utilisateur, avec ses réglages. */
  readonly fetchConversations: () => Promise<readonly RemoteConversation[]>;
  /**
   * Une page de changements, triée par `changeSeq` croissant.
   *
   * L'ordre n'est pas un confort : le curseur avance page par page, et une
   * page non triée le ferait sauter par-dessus des lignes non appliquées.
   */
  readonly fetchMessages: (query: MessagePageQueryRemote) => Promise<readonly RemoteMessage[]>;
}

/** Ce qu'une passe de synchronisation a rapporté. */
export interface SyncReport {
  /** Conversations créées ou mises à jour localement. */
  readonly conversations: number;
  /** Messages écrits localement — insertions et mises à jour confondues. */
  readonly messages: number;
  /** Pages récupérées. Permet de vérifier que la reprise est bien delta. */
  readonly pages: number;
  /** Conversations dont la synchronisation a échoué : reprises à la passe suivante. */
  readonly failed: number;
  /** Conversations dont le curseur a dû être remis à zéro. */
  readonly reset: number;
}

export const EMPTY_SYNC_REPORT: SyncReport = {
  conversations: 0,
  messages: 0,
  pages: 0,
  failed: 0,
  reset: 0,
};

/** Taille d'une page de synchronisation. */
export const SYNC_PAGE_SIZE = 200;
