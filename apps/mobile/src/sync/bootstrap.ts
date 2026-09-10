import { createSupabaseTransport, getClient, hasClient } from '@kola/api';

import { getDatabase } from '../db/client';
import { createNetworkMonitor } from '../network/monitor';
import { subscribeNetInfo } from '../network/netinfo';
import { createReachabilityProbe } from '../network/probe';
import { connectMonitorToStore } from '../network/store';
import type { LocalDatabase } from '../repositories/database';

import { createOutboxProcessor } from './outbox-processor';
import { createOutboxScheduler, type OutboxScheduler } from './scheduler';

/**
 * Câblage de la chaîne de synchronisation.
 *
 * C'est ici que les pièces écrites séparément se rejoignent :
 *
 *   transport (PostgREST) → moteur d'envoi → ordonnanceur → détecteur réseau
 *
 * Chacune ignore les autres : le moteur ne connaît que l'interface de
 * transport, le détecteur ne connaît qu'un `trigger()`. C'est ce découplage
 * qui a permis de tester l'ensemble sans réseau, et qui rendra un changement
 * d'hébergeur indolore (spike #104).
 */

interface SyncHandle {
  readonly scheduler: OutboxScheduler;
  readonly stop: () => void;
}

let handle: SyncHandle | null = null;

/**
 * Démarre la synchronisation.
 *
 * Sans client configuré — le cas tant que le projet serveur n'est pas câblé
 * (#7) — la fonction ne fait rien et le retourne franchement. L'application
 * reste alors pleinement utilisable en local : c'est tout l'intérêt du
 * local-first (ADR-0002).
 */
export function startSync(): boolean {
  if (handle !== null) {
    return true;
  }
  if (!hasClient()) {
    return false;
  }

  const db = getDatabase() as unknown as LocalDatabase;
  const transport = createSupabaseTransport(getClient());

  const processor = createOutboxProcessor({ db, transport });
  const scheduler = createOutboxScheduler({ processor });

  const monitor = createNetworkMonitor({
    subscribeNative: subscribeNetInfo,
    // La sonde interroge NOTRE serveur, pas un point d'entrée tiers : c'est la
    // seule question qui compte, et un portail captif ne saura pas y répondre.
    probe: createReachabilityProbe({ url: `${supabaseUrl()}/auth/v1/health` }),
    // Le déclencheur utile : c'est lui qui fait partir les messages écrits
    // pendant la coupure (#54, #55).
    onBackOnline: () => {
      void scheduler.trigger();
    },
  });

  const disconnectStore = connectMonitorToStore(monitor);
  monitor.start();
  scheduler.start();

  handle = {
    scheduler,
    stop: () => {
      scheduler.stop();
      monitor.stop();
      disconnectStore();
    },
  };

  return true;
}

export function stopSync(): void {
  handle?.stop();
  handle = null;
}

/** Force une passe, par exemple au retour de l'application au premier plan. */
export function triggerSync(): void {
  void handle?.scheduler.trigger();
}

function supabaseUrl(): string {
  // L'URL du client fait foi : elle vient de la même configuration, et éviter
  // de la relire deux fois évite qu'elles divergent.
  return (getClient() as unknown as { supabaseUrl: string }).supabaseUrl;
}
