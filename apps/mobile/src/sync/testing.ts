import {
  type AddMembersPayload,
  type ConversationPrefsPayload,
  type CreateGroupPayload,
  type CreateGroupResult,
  type LeaveGroupPayload,
  type MemberPayload,
  type SetMemberRolePayload,
  type UpdateGroupPayload,
  DuplicateMessageError,
  TransportError,
  type DeleteMessagePayload,
  type EditMessagePayload,
  type MarkReadPayload,
  type OutboxTransport,
  type ReactionPayload,
  type SendMessagePayload,
  type SendMessageResult,
} from '@kola/core';

/**
 * Transport simulé pour les tests du moteur.
 *
 * Il reproduit ce qui se passe réellement sur un réseau togolais : la connexion
 * tombe, revient, une requête expire, le serveur renvoie un refus. Sans lui, on
 * ne pourrait tester le moteur qu'en conditions favorables — c'est-à-dire dans
 * le seul cas où il n'a aucune importance.
 */

export interface FakeTransportState {
  /** Coupe le réseau : toute requête échoue sans réponse. */
  offline: boolean;
  /** Code HTTP à renvoyer à la prochaine requête, puis effacé. */
  nextStatus: number | null;
  /** Fait répondre « déjà reçu » à la prochaine tentative d'envoi. */
  nextDuplicate: boolean;
}

export interface FakeTransport extends OutboxTransport {
  readonly state: FakeTransportState;
  /** Messages effectivement reçus par le « serveur », dans l'ordre d'arrivée. */
  readonly received: SendMessagePayload[];
  /** Groupes créés, dans l'ordre. */
  readonly createdGroups: CreateGroupPayload[];
  /** Opérations d'administration reçues, dans l'ordre, pour les assertions. */
  readonly adminCalls: { op: string; payload: unknown }[];
  readonly edited: EditMessagePayload[];
  readonly deleted: DeleteMessagePayload[];
  readonly reads: MarkReadPayload[];
  readonly reactions: ReactionPayload[];
  readonly goOffline: () => void;
  readonly goOnline: () => void;
  readonly failNextWith: (status: number) => void;
}

export function createFakeTransport(): FakeTransport {
  const state: FakeTransportState = { offline: false, nextStatus: null, nextDuplicate: false };
  const received: SendMessagePayload[] = [];
  const createdGroups: CreateGroupPayload[] = [];
  const adminCalls: { op: string; payload: unknown }[] = [];
  const edited: EditMessagePayload[] = [];
  const deleted: DeleteMessagePayload[] = [];
  const reads: MarkReadPayload[] = [];
  const reactions: ReactionPayload[] = [];

  // Le serveur attribue les seq, comme le trigger Postgres le fait réellement.
  const seqByConversation = new Map<string, number>();
  let idCounter = 0;

  function guard(): void {
    if (state.offline) {
      // Pas de réponse du tout : c'est ce que voit le client quand la
      // connexion tombe, et c'est transitoire par nature.
      throw new TransportError('réseau indisponible', null);
    }
    if (state.nextStatus !== null) {
      const status = state.nextStatus;
      state.nextStatus = null;
      throw new TransportError(`erreur serveur ${status}`, status);
    }
  }

  /** Les opérations d'administration n'ont rien à rendre : elles réussissent ou lèvent. */
  function record(op: string, payload: unknown): Promise<void> {
    guard();
    adminCalls.push({ op, payload });
    return Promise.resolve();
  }

  return {
    state,
    received,
    createdGroups,
    adminCalls,
    edited,
    deleted,
    reads,
    reactions,

    goOffline: () => {
      state.offline = true;
    },
    goOnline: () => {
      state.offline = false;
    },
    failNextWith: (status: number) => {
      state.nextStatus = status;
    },

    updateGroup: (payload: UpdateGroupPayload): Promise<void> => record('update_group', payload),
    addMembers: (payload: AddMembersPayload): Promise<void> => record('add_members', payload),
    removeMember: (payload: MemberPayload): Promise<void> => record('remove_member', payload),
    setMemberRole: (payload: SetMemberRolePayload): Promise<void> =>
      record('set_member_role', payload),
    transferOwnership: (payload: MemberPayload): Promise<void> =>
      record('transfer_ownership', payload),
    leaveGroup: (payload: LeaveGroupPayload): Promise<void> => record('leave_group', payload),
    setConversationPrefs: (payload: ConversationPrefsPayload): Promise<void> =>
      record('set_conversation_prefs', payload),

    createGroup: (payload: CreateGroupPayload): Promise<CreateGroupResult> => {
      guard();
      // La fonction serveur est idempotente par `client_id` : une réémission
      // retrouve le groupe au lieu d'en créer un second. Le faux transport doit
      // se comporter pareil, sans quoi les tests d'idempotence passeraient ici
      // et échoueraient en production.
      const existing = createdGroups.find((g) => g.clientId === payload.clientId);
      if (existing !== undefined) {
        return Promise.resolve({ id: `srv-${existing.clientId}` });
      }
      createdGroups.push(payload);
      return Promise.resolve({ id: `srv-${payload.clientId}` });
    },

    sendMessage: (payload: SendMessagePayload): Promise<SendMessageResult> => {
      guard();

      const alreadyThere = received.find((m) => m.clientId === payload.clientId);
      if (alreadyThere || state.nextDuplicate) {
        state.nextDuplicate = false;
        const index = received.findIndex((m) => m.clientId === payload.clientId);
        const existingSeq = index >= 0 ? index + 1 : 1;
        return Promise.reject(
          new DuplicateMessageError({ id: `srv-${payload.clientId}`, seq: existingSeq }),
        );
      }

      const seq = (seqByConversation.get(payload.conversationId) ?? 0) + 1;
      seqByConversation.set(payload.conversationId, seq);
      received.push(payload);
      idCounter += 1;

      return Promise.resolve({ id: `srv-${String(idCounter)}`, seq });
    },

    editMessage: (payload: EditMessagePayload): Promise<void> => {
      guard();
      edited.push(payload);
      return Promise.resolve();
    },

    deleteMessage: (payload: DeleteMessagePayload): Promise<void> => {
      guard();
      deleted.push(payload);
      return Promise.resolve();
    },

    markRead: (payload: MarkReadPayload): Promise<void> => {
      guard();
      reads.push(payload);
      return Promise.resolve();
    },

    addReaction: (payload: ReactionPayload): Promise<void> => {
      guard();
      reactions.push(payload);
      return Promise.resolve();
    },

    removeReaction: (payload: ReactionPayload): Promise<void> => {
      guard();
      reactions.push(payload);
      return Promise.resolve();
    },
  };
}
