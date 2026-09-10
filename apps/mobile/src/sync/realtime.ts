import type { RealtimeSubscriber, RemoteMessage } from '@kola/core';

import type { LocalDatabase } from '../repositories/database';
import { applyRealtimeMessage } from '../repositories/sync';

/**
 * Pont entre Realtime et la base locale (#50).
 *
 * Le temps réel est ce qui distingue une messagerie d'une boîte de courrier.
 * Mais dans l'architecture local-first il n'est **qu'une optimisation de
 * latence** : la synchronisation par curseur (#53) reste la source de vérité.
 *
 * Trois règles en découlent, et elles sont toutes contre-intuitives.
 *
 * **1. Un événement Realtime n'avance JAMAIS le curseur de synchronisation.**
 * C'est le point le plus important du fichier. Realtime n'offre aucune garantie
 * de livraison ni d'ordre : recevoir l'écriture n° 47 ne prouve pas qu'on a reçu
 * la 46. Avancer le curseur à 47 condamnerait la 46 à ne jamais être demandée —
 * un message perdu définitivement, sans trace. On écrit donc la ligne, et on
 * laisse le curseur où il est : la passe delta la redemandera, l'écrira une
 * seconde fois par-dessus la même clé, et avancera le curseur pour de bon.
 *
 * **2. L'événement passe par SQLite, jamais directement par l'interface.**
 * Sinon un message reçu en temps réel s'afficherait sans exister en base, et
 * disparaîtrait au prochain redémarrage.
 *
 * **3. Toute reconnexion est suivie d'un rattrapage.** Sans exception : ce qui
 * s'est passé pendant la coupure n'a été livré à personne.
 *
 * On ne s'abonne qu'à la conversation ouverte. Cinquante canaux ouverts
 * épuiseraient la batterie et le forfait pour des fils que personne ne regarde.
 */

export interface RealtimeBridgeOptions {
  readonly db: LocalDatabase;
  readonly subscriber: RealtimeSubscriber;
  /**
   * Rattrapage par curseur, appelé après chaque (re)connexion. C'est la
   * garantie qui manque à Realtime.
   */
  readonly resync: (conversationId: string) => void;
  /** Notifié après chaque écriture, pour rafraîchir l'écran. */
  readonly onApplied?: (message: RemoteMessage) => void;
  readonly onError?: (error: unknown) => void;
}

export interface RealtimeBridge {
  /** Ouvre le canal d'une conversation. Ferme le précédent s'il y en avait un. */
  readonly open: (conversationId: string) => void;
  /** Ferme le canal courant. Appelé au départ de l'écran et en arrière-plan. */
  readonly close: () => void;
  /** Conversation actuellement suivie, ou `null`. */
  readonly current: () => string | null;
}

export function createRealtimeBridge(options: RealtimeBridgeOptions): RealtimeBridge {
  const { db, subscriber, resync } = options;

  let conversationId: string | null = null;
  let unsubscribe: (() => void) | null = null;

  function close(): void {
    unsubscribe?.();
    unsubscribe = null;
    conversationId = null;
  }

  return {
    open: (nextConversationId: string) => {
      if (conversationId === nextConversationId) {
        return;
      }
      close();
      conversationId = nextConversationId;

      unsubscribe = subscriber.subscribe(nextConversationId, {
        onMessage: (message: RemoteMessage) => {
          try {
            // Écriture locale seule. Le curseur ne bouge pas : voir la règle 1.
            applyRealtimeMessage(db, message);
            options.onApplied?.(message);
          } catch (error) {
            // Une écriture ratée n'est pas grave ici : la passe delta
            // rattrapera la ligne, puisque le curseur ne l'a pas dépassée.
            options.onError?.(error);
          }
        },

        onConnected: () => {
          // Sans exception, même à la toute première connexion : entre
          // l'ouverture de l'écran et l'établissement du canal, il s'écoule un
          // aller-retour pendant lequel rien n'est livré.
          resync(nextConversationId);
        },

        onError: (error: unknown) => {
          options.onError?.(error);
        },
      });
    },

    close,
    current: () => conversationId,
  };
}
