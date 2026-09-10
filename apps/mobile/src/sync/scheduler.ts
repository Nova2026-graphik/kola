import type { OutboxRunReport } from '@kola/core';

import type { OutboxProcessor } from './outbox-processor';

/**
 * Déclenchement des passes de la file.
 *
 * Trois occasions de vider la file, par ordre d'importance :
 *
 *   1. **au retour du réseau** — c'est le déclencheur utile, celui qui fait
 *      partir les messages écrits pendant la coupure ;
 *   2. **au démarrage**, parce que l'application a pu être tuée avec des
 *      messages en attente ;
 *   3. **périodiquement**, en dernier recours, pour rattraper une temporisation
 *      arrivée à échéance sans qu'aucun événement ne se produise.
 *
 * Le minuteur est volontairement lent. Sur un réseau instable, une boucle
 * serrée consomme plus de données en reconnexions qu'elle n'en transmet
 * réellement, et vide la batterie pour rien.
 */

/** Intervalle de repli entre deux passes, en millisecondes. */
export const DEFAULT_POLL_INTERVAL_MS = 30_000;

export interface SchedulerTimers {
  readonly setInterval: (handler: () => void, ms: number) => unknown;
  readonly clearInterval: (handle: unknown) => void;
}

export interface OutboxSchedulerOptions {
  readonly processor: OutboxProcessor;
  readonly intervalMs?: number;
  readonly timers?: SchedulerTimers;
  readonly onError?: (error: unknown) => void;
}

export interface OutboxScheduler {
  /** Démarre le minuteur et déclenche une première passe immédiatement. */
  readonly start: () => void;
  /** Arrête le minuteur. Une passe en cours va à son terme. */
  readonly stop: () => void;
  /**
   * Déclenche une passe hors minuteur.
   *
   * Appelé par le détecteur d'état réseau au retour de la connexion (#55), et
   * au retour de l'application au premier plan.
   */
  readonly trigger: () => Promise<OutboxRunReport | null>;
  readonly isStarted: () => boolean;
}

export function createOutboxScheduler(options: OutboxSchedulerOptions): OutboxScheduler {
  const { processor } = options;
  const intervalMs = options.intervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const timers: SchedulerTimers = options.timers ?? {
    setInterval: (handler, ms) => globalThis.setInterval(handler, ms),
    clearInterval: (handle) => {
      globalThis.clearInterval(handle as ReturnType<typeof globalThis.setInterval>);
    },
  };

  let handle: unknown = null;

  async function runSafely(): Promise<OutboxRunReport | null> {
    try {
      return await processor.runOnce();
    } catch (error) {
      // Une passe qui échoue ne doit jamais arrêter l'ordonnanceur : la
      // prochaine occasion doit rester possible, sinon un incident isolé
      // condamnerait tous les messages en attente.
      options.onError?.(error);
      return null;
    }
  }

  return {
    start: () => {
      if (handle !== null) {
        return;
      }
      handle = timers.setInterval(() => {
        void runSafely();
      }, intervalMs);
      // L'application a pu être tuée avec des messages en attente.
      void runSafely();
    },

    stop: () => {
      if (handle === null) {
        return;
      }
      timers.clearInterval(handle);
      handle = null;
    },

    trigger: () => runSafely(),

    isStarted: () => handle !== null,
  };
}
