import type { RealtimeChannel } from '@supabase/supabase-js';

import {
  realtimeRetryDelay,
  type MessageKind,
  type RealtimeHandlers,
  type RealtimeSubscriber,
  type RemoteMessage,
  type Unsubscribe,
} from '@kola/core';

import type { KolaClient } from './client';

/**
 * Abonnement Realtime sur une conversation (#50).
 *
 * Ce fichier est le seul à savoir qu'il y a un WebSocket au bout. Le pont qui
 * consomme les événements ne connaît que `RealtimeSubscriber` : trois rappels,
 * pas la moindre notion de canal. C'est ce qui permet de tester toute la logique
 * d'application des événements sans réseau.
 *
 * La reconnexion vit ici plutôt que dans le pont pour la même raison : elle est
 * indissociable du transport, et sa temporisation dépend de ce que le transport
 * sait de l'échec.
 *
 * ---
 *
 * **Piège vérifié sur la pile locale** : le socket Realtime a sa propre
 * authentification, distincte des en-têtes HTTP. Un client dont le jeton est
 * posé à la main dans `global.headers` — sans passer par le module `auth` —
 * ouvre le canal, reçoit `SUBSCRIBED`… et ne reçoit **jamais** le moindre
 * événement : l'abonnement n'est même pas enregistré côté serveur. L'échec est
 * totalement silencieux.
 *
 * Le client de `client.ts` passe par le module `auth`, qui propage la session au
 * socket de lui-même : rien à faire ici. Mais quiconque écrira un script de
 * diagnostic avec un jeton forgé devra appeler `realtime.setAuth(token)`, sans
 * quoi il conclura à tort que la publication ou les policies sont en cause.
 *
 * Vérifié aussi, dans la même passe : un utilisateur NON membre de la
 * conversation ne reçoit rien. La RLS s'applique bien aux abonnés.
 */

export interface RealtimeOptions {
  /** Minuteurs injectables : les tests ne doivent pas attendre une minute. */
  readonly timers?: {
    readonly setTimeout: (handler: () => void, ms: number) => unknown;
    readonly clearTimeout: (handle: unknown) => void;
  };
  readonly random?: () => number;
  /** Vrai quand l'application est au premier plan. */
  readonly isForeground?: () => boolean;
}

interface MessageRecord {
  id: string;
  client_id: string;
  conversation_id: string;
  sender_id: string | null;
  seq: number | string;
  change_seq: number | string;
  kind: MessageKind;
  body: string | null;
  reply_to_id: string | null;
  edited_at: string | null;
  deleted_at: string | null;
  created_at: string | null;
}

function toRemoteMessage(record: MessageRecord): RemoteMessage {
  const at = (value: string | null): number | null => (value === null ? null : Date.parse(value));
  return {
    id: record.id,
    clientId: record.client_id,
    conversationId: record.conversation_id,
    senderId: record.sender_id,
    seq: Number(record.seq),
    changeSeq: Number(record.change_seq),
    kind: record.kind,
    body: record.body,
    replyToId: record.reply_to_id,
    editedAt: at(record.edited_at),
    deletedAt: at(record.deleted_at),
    createdAt: at(record.created_at) ?? 0,
  };
}

export function createRealtimeSubscriber(
  supabase: KolaClient,
  options: RealtimeOptions = {},
): RealtimeSubscriber {
  const timers = options.timers ?? {
    setTimeout: (handler: () => void, ms: number) => globalThis.setTimeout(handler, ms),
    clearTimeout: (handle: unknown) => {
      globalThis.clearTimeout(handle as ReturnType<typeof globalThis.setTimeout>);
    },
  };
  const random = options.random ?? Math.random;
  const isForeground = options.isForeground ?? (() => true);

  return {
    subscribe: (conversationId: string, handlers: RealtimeHandlers): Unsubscribe => {
      let channel: RealtimeChannel | null = null;
      let retryHandle: unknown = null;
      let attempt = 0;
      let closed = false;

      function connect(): void {
        if (closed) {
          return;
        }

        channel = supabase
          .channel(`conversation:${conversationId}`)
          .on(
            'postgres_changes',
            {
              event: '*',
              schema: 'public',
              table: 'messages',
              // Un canal par conversation OUVERTE. Sans ce filtre, l'appareil
              // recevrait le trafic de tous les fils de l'utilisateur — le
              // contraire de l'économie de données recherchée.
              filter: `conversation_id=eq.${conversationId}`,
            },
            (payload) => {
              // La suppression étant logique (ADR-0002), il n'arrive jamais
              // d'événement DELETE : une suppression est une modification.
              const record = payload.new as Partial<MessageRecord>;
              // Un événement DELETE porte un `new` vide. Il ne devrait jamais
              // arriver, mais le contrôle coûte moins que la panne qu'il évite.
              if (typeof record.id !== 'string' || typeof record.client_id !== 'string') {
                return;
              }
              handlers.onMessage(toRemoteMessage(record as MessageRecord));
            },
          )
          .subscribe((status, error) => {
            if (closed) {
              return;
            }

            if (status === 'SUBSCRIBED') {
              attempt = 0;
              handlers.onConnected();
              return;
            }

            if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
              if (error !== undefined) {
                handlers.onError(error);
              }
              scheduleRetry();
            }
          });
      }

      function scheduleRetry(): void {
        if (closed || retryHandle !== null) {
          return;
        }
        // « Cesser les tentatives en arrière-plan » (#50) : un appareil rangé
        // dans une poche ne doit pas rouvrir un WebSocket toutes les minutes.
        if (!isForeground()) {
          return;
        }

        attempt += 1;
        retryHandle = timers.setTimeout(
          () => {
            retryHandle = null;
            teardown();
            connect();
          },
          realtimeRetryDelay(attempt, random),
        );
      }

      function teardown(): void {
        if (channel !== null) {
          void supabase.removeChannel(channel);
          channel = null;
        }
      }

      connect();

      return () => {
        closed = true;
        if (retryHandle !== null) {
          timers.clearTimeout(retryHandle);
          retryHandle = null;
        }
        teardown();
      };
    },
  };
}
