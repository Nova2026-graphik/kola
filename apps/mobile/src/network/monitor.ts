import {
  INITIAL_NETWORK_STATE,
  type ConnectionType,
  type NetworkState,
  type NetworkStatus,
} from '@kola/core';

/**
 * Surveillance de l'état réseau.
 *
 * Deux sources d'information, et il faut les deux :
 *
 *   * la **détection native** (`@react-native-community/netinfo`), qui dit s'il
 *     existe un réseau et de quel type. Elle est immédiate mais ment sur
 *     l'essentiel : un portail captif se déclare connecté ;
 *
 *   * une **sonde de joignabilité**, qui dit si le serveur répond vraiment.
 *     Elle est fiable mais coûte des données, donc elle est espacée et ne
 *     tourne jamais quand tout va bien.
 *
 * La sonde ne s'exécute qu'à trois occasions : au démarrage, à chaque
 * changement d'état de la connexion, et périodiquement tant que l'état est
 * `limited` — c'est-à-dire uniquement quand l'information manque. Sonder en
 * boucle alors que tout fonctionne dépenserait le forfait de l'utilisateur
 * pour confirmer ce qu'on sait déjà.
 */

export interface NativeNetworkSnapshot {
  readonly isConnected: boolean;
  readonly connectionType: ConnectionType;
  readonly isMetered: boolean;
}

/** Retourne vrai si le serveur répond. Ne doit jamais lever. */
export type ReachabilityProbe = () => Promise<boolean>;

export type NativeSubscription = (
  listener: (snapshot: NativeNetworkSnapshot) => void,
) => () => void;

export interface MonitorTimers {
  readonly setTimeout: (handler: () => void, ms: number) => unknown;
  readonly clearTimeout: (handle: unknown) => void;
}

export interface NetworkMonitorOptions {
  readonly subscribeNative: NativeSubscription;
  readonly probe: ReachabilityProbe;
  readonly timers?: MonitorTimers;
  /** Intervalle entre deux sondes tant que l'état reste `limited`. */
  readonly limitedRetryMs?: number;
  /** Appelé quand la connexion redevient exploitable. */
  readonly onBackOnline?: () => void;
}

export interface NetworkMonitor {
  readonly getState: () => NetworkState;
  readonly subscribe: (listener: (state: NetworkState) => void) => () => void;
  readonly start: () => void;
  readonly stop: () => void;
  /** Force une vérification, par exemple au retour au premier plan. */
  readonly check: () => Promise<NetworkStatus>;
  readonly setSyncing: (syncing: boolean) => void;
  readonly setPendingCount: (count: number) => void;
}

/** Espacement des sondes tant que le serveur ne répond pas. */
export const DEFAULT_LIMITED_RETRY_MS = 15_000;

export function createNetworkMonitor(options: NetworkMonitorOptions): NetworkMonitor {
  const limitedRetryMs = options.limitedRetryMs ?? DEFAULT_LIMITED_RETRY_MS;
  const timers: MonitorTimers = options.timers ?? {
    setTimeout: (handler, ms) => globalThis.setTimeout(handler, ms),
    clearTimeout: (handle) => {
      globalThis.clearTimeout(handle as ReturnType<typeof globalThis.setTimeout>);
    },
  };

  let state: NetworkState = INITIAL_NETWORK_STATE;
  let unsubscribeNative: (() => void) | null = null;
  let retryHandle: unknown = null;
  let probeToken = 0;

  const listeners = new Set<(state: NetworkState) => void>();

  function emit(): void {
    for (const listener of listeners) {
      listener(state);
    }
  }

  function update(next: Partial<NetworkState>): void {
    const previous = state;
    state = { ...state, ...next };

    if (
      previous.status !== state.status ||
      previous.connectionType !== state.connectionType ||
      previous.isMetered !== state.isMetered ||
      previous.isSyncing !== state.isSyncing ||
      previous.pendingCount !== state.pendingCount
    ) {
      emit();
    }

    // Le déclencheur utile : c'est lui qui fait partir les messages écrits
    // pendant la coupure (#54).
    if (previous.status !== 'online' && state.status === 'online') {
      options.onBackOnline?.();
    }
  }

  function cancelRetry(): void {
    if (retryHandle !== null) {
      timers.clearTimeout(retryHandle);
      retryHandle = null;
    }
  }

  function scheduleRetry(): void {
    cancelRetry();
    retryHandle = timers.setTimeout(() => {
      retryHandle = null;
      void check();
    }, limitedRetryMs);
  }

  async function check(): Promise<NetworkStatus> {
    // Sans réseau du tout, inutile de sonder : la réponse est connue, et une
    // requête vouée à l'échec coûte de la batterie.
    if (state.connectionType === 'none') {
      cancelRetry();
      update({ status: 'offline' });
      return 'offline';
    }

    // Une sonde plus ancienne peut revenir après une plus récente : seul le
    // dernier jeton émis fait foi.
    probeToken += 1;
    const token = probeToken;

    // On n'annonce « reconnexion » que si l'on ne se croyait pas déjà en ligne.
    // Sinon une simple revérification — au retour au premier plan, par exemple —
    // ferait osciller l'état online → reconnecting → online, ce qui relancerait
    // une passe complète de la file à chaque contrôle et afficherait un bandeau
    // alors que tout fonctionne.
    if (state.status !== 'online') {
      update({ status: 'reconnecting' });
    }

    let reachable: boolean;
    try {
      reachable = await options.probe();
    } catch {
      // Une sonde ne doit jamais faire tomber la surveillance : une exception
      // se lit comme « injoignable ».
      reachable = false;
    }

    if (token !== probeToken) {
      return state.status;
    }

    if (reachable) {
      cancelRetry();
      update({ status: 'online' });
      return 'online';
    }

    // Réseau présent mais serveur muet : portail captif, DNS cassé, panne.
    update({ status: 'limited' });
    scheduleRetry();
    return 'limited';
  }

  function onNative(snapshot: NativeNetworkSnapshot): void {
    const connectionType: ConnectionType = snapshot.isConnected ? snapshot.connectionType : 'none';

    update({
      connectionType,
      // Un partage de connexion se présente comme du Wi-Fi tout en consommant
      // un forfait mobile : quand la plateforme le signale, on la croit.
      isMetered: snapshot.isMetered || connectionType === 'cellular',
    });

    void check();
  }

  return {
    getState: () => state,

    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    start: () => {
      if (unsubscribeNative) {
        return;
      }
      unsubscribeNative = options.subscribeNative(onNative);
    },

    stop: () => {
      cancelRetry();
      // Invalide toute sonde encore en vol.
      probeToken += 1;
      unsubscribeNative?.();
      unsubscribeNative = null;
    },

    check,

    setSyncing: (syncing: boolean) => {
      update({ isSyncing: syncing });
    },

    setPendingCount: (count: number) => {
      update({ pendingCount: Math.max(0, count) });
    },
  };
}
