import {
  DuplicateMessageError,
  type AddMembersPayload,
  type ConversationPrefsPayload,
  type CreateGroupPayload,
  type CreateGroupResult,
  type LeaveGroupPayload,
  type MemberPayload,
  type SetMemberRolePayload,
  type UpdateGroupPayload,
  TransportError,
  type DeleteMessagePayload,
  type EditMessagePayload,
  type MarkReadPayload,
  type OutboxTransport,
  type ReactionPayload,
  type SendMessagePayload,
  type SendMessageResult,
} from '@kola/core';

import type { KolaClient } from './client';
import { toTransportError, UNIQUE_VIOLATION } from './transport-errors';

/**
 * Transport de la file d'attente sortante, sur PostgREST.
 *
 * C'est la pièce qui manquait entre le moteur d'envoi (#54) et le serveur.
 * Le moteur ne connaît que l'interface `OutboxTransport` : ce fichier est le
 * seul à savoir que l'autre bout est du Postgres exposé par PostgREST.
 *
 * Conséquence utile : il fonctionne à l'identique sur Supabase hébergé,
 * auto-hébergé, ou sur toute installation exposant PostgREST et GoTrue. Un
 * changement d'hébergeur ne touche pas une ligne du moteur (voir spike #104).
 */

export function createSupabaseTransport(supabase: KolaClient): OutboxTransport {
  const client = (): KolaClient => supabase;

  /**
   * Retrouve un message déjà reçu par le serveur.
   *
   * Appelé quand l'insertion échoue sur l'unicité du `client_id`. Ce n'est pas
   * une erreur : c'est l'idempotence qui fonctionne — le message était bien
   * parti, seule la réponse s'était perdue.
   */
  async function findByClientId(clientId: string): Promise<SendMessageResult | null> {
    const { data, error } = await client()
      .from('messages')
      .select('id, seq')
      .eq('client_id', clientId)
      .maybeSingle();

    if (error || data === null) {
      return null;
    }
    return { id: data.id, seq: Number(data.seq) };
  }

  return {
    sendMessage: async (payload: SendMessagePayload): Promise<SendMessageResult> => {
      const { data, error } = await client()
        .from('messages')
        .insert({
          client_id: payload.clientId,
          conversation_id: payload.conversationId,
          sender_id: payload.senderId,
          kind: payload.kind,
          body: payload.body,
          reply_to_id: payload.replyToId,
        })
        // `seq` est attribué par un trigger sous verrou de ligne (#10) : c'est
        // le serveur qui fait foi, on le relit plutôt que de le deviner.
        .select('id, seq')
        .single();

      if (error) {
        if (error.code === UNIQUE_VIOLATION) {
          const existing = await findByClientId(payload.clientId);
          if (existing) {
            throw new DuplicateMessageError(existing);
          }
          // Unicité violée sans message retrouvable : le blocage a une autre
          // cause, et la réémission n'y changera rien.
          throw new TransportError(error.message, 409);
        }
        throw toTransportError(error);
      }

      return { id: data.id, seq: Number(data.seq) };
    },

    createGroup: async (payload: CreateGroupPayload): Promise<CreateGroupResult> => {
      // Fonction serveur plutôt que trois insertions : la conversation et tous
      // ses membres naissent dans une seule transaction. En deux appels, un
      // échec du second laisserait un groupe sans membres — invisible pour
      // tout le monde, y compris son créateur, et impossible à supprimer (#37).
      // `p_avatar_url` a une valeur par défaut côté serveur : on omet la clé
      // plutôt que d'envoyer `undefined`, qu'`exactOptionalPropertyTypes`
      // distingue d'une clé absente.
      const { data, error } = await client().rpc('create_group', {
        p_client_id: payload.clientId,
        p_title: payload.title,
        p_member_ids: [...payload.memberIds],
        ...(payload.avatarUrl === null ? {} : { p_avatar_url: payload.avatarUrl }),
      });

      if (error) {
        throw toTransportError(error);
      }
      // La fonction est idempotente par `client_id` : une réémission après
      // coupure retrouve le groupe déjà créé plutôt que d'en fabriquer un
      // second. Il n'y a donc pas de cas de doublon à traiter ici.
      return { id: data as unknown as string };
    },

    updateGroup: async (payload: UpdateGroupPayload): Promise<void> => {
      // Un UPDATE direct plutôt qu'une fonction : la policy `edit_group` et le
      // trigger d'immuabilité portent déjà toute la règle, et un membre simple
      // ne touche donc aucune ligne. La contrepartie est que l'absence
      // d'erreur ne prouve pas la modification — RLS filtre en silence sur
      // l'UPDATE. La synchronisation delta rétablira la vérité.
      // Seules les clés fournies sont envoyées : un `undefined` explicite
      // écraserait la valeur serveur par `null` une fois sérialisé en JSON.
      const patch = {
        ...(payload.title === undefined ? {} : { title: payload.title }),
        ...(payload.description === undefined ? {} : { description: payload.description }),
        ...(payload.avatarUrl === undefined ? {} : { avatar_url: payload.avatarUrl }),
        ...(payload.restricted === undefined ? {} : { restricted: payload.restricted }),
      };

      const { error } = await client()
        .from('conversations')
        .update(patch)
        .eq('id', payload.conversationId);

      if (error) {
        throw toTransportError(error);
      }
    },

    addMembers: async (payload: AddMembersPayload): Promise<void> => {
      if (payload.userIds.length === 0) {
        return;
      }
      const { error } = await client()
        .from('conversation_members')
        .insert(
          payload.userIds.map((userId) => ({
            conversation_id: payload.conversationId,
            user_id: userId,
            role: 'member' as const,
          })),
        )
        .select();

      if (error) {
        // Quelqu'un déjà membre : réémettre est sûr, et un doublon signifie
        // simplement que l'ajout a déjà eu lieu.
        if (error.code === UNIQUE_VIOLATION) {
          return;
        }
        throw toTransportError(error);
      }
    },

    removeMember: async (payload: MemberPayload): Promise<void> => {
      const { error } = await client()
        .from('conversation_members')
        .delete()
        .eq('conversation_id', payload.conversationId)
        .eq('user_id', payload.userId);

      if (error) {
        throw toTransportError(error);
      }
    },

    setMemberRole: async (payload: SetMemberRolePayload): Promise<void> => {
      const { error } = await client()
        .from('conversation_members')
        .update({ role: payload.role })
        .eq('conversation_id', payload.conversationId)
        .eq('user_id', payload.userId);

      if (error) {
        throw toTransportError(error);
      }
    },

    transferOwnership: async (payload: MemberPayload): Promise<void> => {
      // Fonction serveur obligatoire : les deux lignes de rôle et la
      // conversation changent ensemble, et prises isolément les gardes
      // refuseraient chacune d'elles (#39).
      const { error } = await client().rpc('transfer_ownership', {
        target_conversation: payload.conversationId,
        new_owner: payload.userId,
      });

      if (error) {
        throw toTransportError(error);
      }
    },

    leaveGroup: async (payload: LeaveGroupPayload): Promise<void> => {
      const { data: session } = await client().auth.getSession();
      const userId = session.session?.user.id;
      if (userId === undefined) {
        // Sans session, l'entrée ne partira jamais : autant l'abandonner que
        // la laisser bloquer la file indéfiniment.
        throw new TransportError('session absente', 401);
      }

      const { error } = await client()
        .from('conversation_members')
        .delete()
        .eq('conversation_id', payload.conversationId)
        .eq('user_id', userId);

      if (error) {
        throw toTransportError(error);
      }
    },

    setConversationPrefs: async (payload: ConversationPrefsPayload): Promise<void> => {
      const { data: session } = await client().auth.getSession();
      const userId = session.session?.user.id;
      if (userId === undefined) {
        throw new TransportError('session absente', 401);
      }

      const iso = (at: number | null): string | null =>
        at === null ? null : new Date(at).toISOString();

      const patch = {
        ...(payload.mutedUntil === undefined ? {} : { muted_until: iso(payload.mutedUntil) }),
        ...(payload.pinnedAt === undefined ? {} : { pinned_at: iso(payload.pinnedAt) }),
        ...(payload.archivedAt === undefined ? {} : { archived_at: iso(payload.archivedAt) }),
      };

      const { error } = await client()
        .from('conversation_members')
        .update(patch)
        .eq('conversation_id', payload.conversationId)
        .eq('user_id', userId);

      if (error) {
        throw toTransportError(error);
      }
    },

    editMessage: async (payload: EditMessagePayload): Promise<void> => {
      const { error } = await client()
        .from('messages')
        .update({ body: payload.body })
        .eq('id', payload.messageId);

      if (error) {
        throw toTransportError(error);
      }
    },

    deleteMessage: async (payload: DeleteMessagePayload): Promise<void> => {
      // Suppression LOGIQUE : le corps est vidé, la ligne et son seq restent.
      // Un DELETE physique creuserait un trou dans la suite des seq et
      // casserait la reprise par curseur (ADR-0002). Le schéma l'impose
      // d'ailleurs depuis la migration 20260910120009.
      const { error } = await client()
        .from('messages')
        .update({ deleted_at: new Date().toISOString(), body: null })
        .eq('id', payload.messageId);

      if (error) {
        throw toTransportError(error);
      }
    },

    markRead: async (payload: MarkReadPayload): Promise<void> => {
      // Fonction serveur plutôt qu'un UPDATE direct : elle avance le curseur
      // de façon monotone (#15). Un accusé en retard ne doit jamais faire
      // reculer la lecture et ressusciter des non-lus déjà vus.
      const { error } = await client().rpc('mark_conversation_read', {
        target_conversation: payload.conversationId,
        up_to_seq: payload.upToSeq,
      });

      if (error) {
        throw toTransportError(error);
      }
    },

    addReaction: async (payload: ReactionPayload): Promise<void> => {
      const { error } = await client()
        .from('reactions')
        .insert({ message_id: payload.messageId, emoji: payload.emoji, user_id: payload.userId })
        .select();

      if (error) {
        // La clé primaire composite garantit qu'un même emoji n'est pas posé
        // deux fois (#11) : réémettre est donc sûr, et un doublon signifie
        // simplement que la réaction est déjà là.
        if (error.code === UNIQUE_VIOLATION) {
          return;
        }
        throw toTransportError(error);
      }
    },

    removeReaction: async (payload: ReactionPayload): Promise<void> => {
      const { error } = await client()
        .from('reactions')
        .delete()
        .eq('message_id', payload.messageId)
        .eq('emoji', payload.emoji)
        // La policy limite déjà la suppression à ses propres réactions ; le
        // filtre explicite évite de compter sur elle pour la correction.
        .eq('user_id', payload.userId);

      if (error) {
        throw toTransportError(error);
      }
    },
  };
}
