import type {
  MessagePageQueryRemote,
  RemoteConversation,
  RemoteMessage,
  SyncTransport,
} from '@kola/core';

import type { KolaClient } from './client';
import { toTransportError } from './transport-errors';

/**
 * Transport de la synchronisation delta, sur PostgREST (#53).
 *
 * Deux requêtes, et rien d'autre :
 *
 *   - `conversation_overview`, la vue qui porte déjà les réglages de
 *     l'utilisateur et les compteurs. Elle est en `security_invoker` : elle ne
 *     rend que les conversations dont l'appelant est membre, sans qu'on ait à
 *     le filtrer ici ;
 *
 *   - une page de `messages` filtrée sur `change_seq`, triée par `change_seq`.
 *     Le tri n'est pas cosmétique : le curseur avance au maximum de la page, et
 *     une page non triée le ferait sauter par-dessus des lignes non appliquées.
 *
 * Les listes de colonnes sont écrites en toutes lettres plutôt qu'en `*`. Sur
 * un réseau facturé au mégaoctet, ne transférer que ce qu'on affiche n'est pas
 * une optimisation tardive (ADR-0006). Elles sont aussi des littéraux, ce qui
 * permet aux types générés de décrire exactement les lignes reçues.
 */

// Les pièces jointes ne sont pas demandées : elles suivent leur propre
// politique de téléchargement (#49). Rapatrier un aperçu vidéo en 3G parce
// qu'on rattrape l'historique serait exactement ce que le mode économie de
// données cherche à éviter.
const MESSAGE_COLUMNS =
  'id, client_id, conversation_id, sender_id, seq, change_seq, kind, body, reply_to_id, edited_at, deleted_at, created_at';

const CONVERSATION_COLUMNS =
  'id, type, title, avatar_url, owner_id, community_id, last_message_at, last_message_preview, last_message_sender_id, last_message_kind, last_seq, last_change_seq, last_read_seq, muted_until, pinned_at, archived_at, created_at';

/** Les dates arrivent en ISO ; le schéma local les stocke en millisecondes. */
function toMillis(value: string | null | undefined): number | null {
  return value === null || value === undefined ? null : Date.parse(value);
}

/**
 * La vue est construite sur une jointure, donc PostgREST déclare toutes ses
 * colonnes nullables. Le `not null` des tables sous-jacentes le contredit, mais
 * les types générés ne peuvent pas le savoir : on retombe sur une valeur neutre
 * plutôt que de propager un `null` impossible jusqu'au moteur.
 */
function toNumber(value: number | string | null | undefined): number {
  return value === null || value === undefined ? 0 : Number(value);
}

export function createSyncTransport(supabase: KolaClient): SyncTransport {
  return {
    fetchConversations: async (): Promise<readonly RemoteConversation[]> => {
      const { data, error } = await supabase
        .from('conversation_overview')
        .select(CONVERSATION_COLUMNS);

      if (error) {
        throw toTransportError(error);
      }

      return (data ?? []).map((row) => ({
        id: row.id ?? '',
        type: row.type ?? 'dm',
        title: row.title,
        avatarUrl: row.avatar_url,
        ownerId: row.owner_id,
        communityId: row.community_id,
        lastMessageAt: toMillis(row.last_message_at),
        lastMessagePreview: row.last_message_preview,
        lastMessageSenderId: row.last_message_sender_id,
        lastMessageKind: row.last_message_kind,
        lastSeq: toNumber(row.last_seq),
        lastChangeSeq: toNumber(row.last_change_seq),
        lastReadSeq: toNumber(row.last_read_seq),
        mutedUntil: toMillis(row.muted_until),
        pinnedAt: toMillis(row.pinned_at),
        archivedAt: toMillis(row.archived_at),
        createdAt: toMillis(row.created_at) ?? 0,
      }));
    },

    fetchMessages: async (query: MessagePageQueryRemote): Promise<readonly RemoteMessage[]> => {
      const { data, error } = await supabase
        .from('messages')
        .select(MESSAGE_COLUMNS)
        .eq('conversation_id', query.conversationId)
        .gt('change_seq', query.afterChangeSeq)
        .order('change_seq', { ascending: true })
        .limit(query.limit);

      if (error) {
        throw toTransportError(error);
      }

      return (data ?? []).map((row) => ({
        id: row.id,
        clientId: row.client_id,
        conversationId: row.conversation_id,
        senderId: row.sender_id,
        seq: toNumber(row.seq),
        changeSeq: toNumber(row.change_seq),
        kind: row.kind,
        body: row.body,
        replyToId: row.reply_to_id,
        editedAt: toMillis(row.edited_at),
        deletedAt: toMillis(row.deleted_at),
        createdAt: toMillis(row.created_at) ?? 0,
      }));
    },
  };
}
