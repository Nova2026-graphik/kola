import { AppState, type AppStateStatus } from 'react-native';

import {
  createRealtimeSubscriber,
  createSupabaseTransport,
  createSyncTransport,
  getClient,
  hasClient,
} from '@kola/api';

import { getDatabase } from '../db/client';
import { createNetworkMonitor } from '../network/monitor';
import { subscribeNetInfo } from '../network/netinfo';
import { createReachabilityProbe } from '../network/probe';
import { connectMonitorToStore } from '../network/store';
import type { LocalDatabase } from '../repositories/database';
import { markConversationOpened } from '../repositories/sync';

import { createSyncEngine, type SyncEngine } from './engine';
import { createOutboxProcessor } from './outbox-processor';
import { createRealtimeBridge, type RealtimeBridge } from './realtime';
import { createOutboxScheduler, type OutboxScheduler } from './scheduler';
import { publishSyncState } from './store';

/**
 * Câblage de la chaîne de synchronisation.
 *
 * C'est ici que les pièces écrites séparément se rejoignent :
 *
 *   transport (PostgREST) → moteur d'envoi   → ordonnanceur ┐
 *   transport (PostgREST) → moteur de reprise ──────────────┴→ détecteur réseau
 *
 * Chacune ignore les autres : les moteurs ne connaissent que leur interface de
 * transport, le détecteur ne connaît qu'un déclencheur. C'est ce découplage qui
 * a permis de tester l'ensemble sans réseau, et qui rendra un changement
 * d'hébergeur indolore (spike #104).
 *
 * L'ordre du retour en ligne compte : on vide d'abord la file sortante, puis on
 * rattrape l'entrant. L'inverse ferait revenir du serveur des messages plus
 * récents que ceux que l'utilisateur attend de voir partir, et le fil
 * s'afficherait dans un ordre incompréhensible pendant quelques secondes.
 */

interface SyncHandle {
  readonly scheduler: OutboxScheduler;
  readonly engine: SyncEngine;
  readonly realtime: RealtimeBridge;
  readonly stop: () => void;
}

/**
 * Conversation affichée, indépendamment de l'état du canal.
 *
 * Nécessaire pour rouvrir le bon canal au retour au premier plan : le pont, lui,
 * a été fermé et ne sait plus ce qu'il suivait.
 */
let visibleConversation: string | null = null;

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
  const client = getClient();

  const processor = createOutboxProcessor({ db, transport: createSupabaseTransport(client) });
  const scheduler = createOutboxScheduler({ processor });

  const engine = createSyncEngine({
    db,
    transport: createSyncTransport(client),
    onStateChange: publishSyncState,
  });

  const realtime = createRealtimeBridge({
    db,
    // L'application ne tente pas de se reconnecter en arrière-plan : un
    // appareil rangé dans une poche ne doit pas rouvrir un WebSocket toutes
    // les minutes (#50).
    subscriber: createRealtimeSubscriber(client, {
      isForeground: () => AppState.currentState === 'active',
    }),
    // La garantie qui manque à Realtime. Sans exception : ce qui s'est passé
    // avant l'établissement du canal n'a été livré à personne.
    resync: (conversationId: string) => {
      void engine.syncConversation(conversationId);
    },
  });

  const monitor = createNetworkMonitor({
    subscribeNative: subscribeNetInfo,
    // La sonde interroge NOTRE serveur, pas un point d'entrée tiers : c'est la
    // seule question qui compte, et un portail captif ne saura pas y répondre.
    probe: createReachabilityProbe({ url: `${supabaseUrl()}/auth/v1/health` }),
    // Le déclencheur utile : c'est lui qui fait partir les messages écrits
    // pendant la coupure (#54, #55) et qui rattrape ceux qu'on a manqués (#53).
    onBackOnline: () => {
      void scheduler.trigger().then(() => engine.runOnce());
    },
  });

  const disconnectStore = connectMonitorToStore(monitor);
  monitor.start();
  scheduler.start();

  // Première reprise au démarrage. Sans `await` : l'interface doit être
  // utilisable immédiatement, sur les données déjà en base.
  void engine.runOnce();

  const appStateSubscription = AppState.addEventListener('change', onAppStateChange);

  handle = {
    scheduler,
    engine,
    realtime,
    stop: () => {
      scheduler.stop();
      engine.cancel();
      realtime.close();
      monitor.stop();
      disconnectStore();
      appStateSubscription.remove();
    },
  };

  return true;
}

export function stopSync(): void {
  handle?.stop();
  handle = null;
  visibleConversation = null;
}

/**
 * Ferme les abonnements en arrière-plan, les rouvre au retour.
 *
 * Le critère d'acceptation de #50 est explicite : passer en arrière-plan ferme
 * les abonnements et ne consomme plus de données. Un WebSocket laissé ouvert
 * continue de recevoir — et de coûter — pour un écran que personne ne regarde.
 */
function onAppStateChange(state: AppStateStatus): void {
  if (state === 'active') {
    triggerSync();
    if (visibleConversation !== null) {
      handle?.realtime.open(visibleConversation);
    }
    return;
  }
  handle?.realtime.close();
}

/** Force une passe, par exemple au retour de l'application au premier plan. */
export function triggerSync(): void {
  void handle?.scheduler.trigger().then(() => handle?.engine.runOnce());
}

/**
 * Signale qu'une conversation vient d'être ouverte.
 *
 * Deux effets : elle passe en tête de la file de synchronisation, et on tente
 * de la rattraper tout de suite. La note d'ouverture est prise même quand la
 * synchronisation n'est pas démarrée — hors ligne, l'ordre de priorité servira
 * à la première passe qui suivra le retour du réseau.
 */
export function openConversation(conversationId: string): void {
  visibleConversation = conversationId;
  markConversationOpened(getDatabase() as unknown as LocalDatabase, conversationId, Date.now());
  // Le canal se charge du rattrapage à sa connexion : le déclencher aussi ici
  // ferait deux passes pour un seul écran ouvert.
  handle?.realtime.open(conversationId);
}

/** L'écran de conversation est quitté : plus rien à écouter pour ce fil. */
export function closeConversation(conversationId: string): void {
  if (visibleConversation !== conversationId) {
    return;
  }
  visibleConversation = null;
  handle?.realtime.close();
}

function supabaseUrl(): string {
  // L'URL du client fait foi : elle vient de la même configuration, et éviter
  // de la relire deux fois évite qu'elles divergent.
  return (getClient() as unknown as { supabaseUrl: string }).supabaseUrl;
}
