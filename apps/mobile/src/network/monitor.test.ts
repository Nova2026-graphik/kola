import { describe, expect, it, vi } from 'vitest';

import { bannerFor, canCompose, type NetworkState } from '@kola/core';

import {
  createNetworkMonitor,
  DEFAULT_LIMITED_RETRY_MS,
  type NativeNetworkSnapshot,
  type NetworkMonitor,
} from './monitor';

/**
 * Tests de la surveillance réseau.
 *
 * Le cas qui compte le plus n'est pas « hors ligne » — celui-là est facile.
 * C'est le portail captif : un réseau qui se déclare connecté alors que rien
 * ne passe. Une messagerie qui s'y fie affiche « en ligne » pendant que les
 * messages s'empilent sans partir.
 */

interface Harness {
  readonly monitor: NetworkMonitor;
  readonly emitNative: (snapshot: NativeNetworkSnapshot) => void;
  readonly setReachable: (reachable: boolean) => void;
  readonly probeCount: () => number;
  readonly backOnlineCount: () => number;
}

function createHarness(options: { failProbe?: boolean } = {}): Harness {
  let listener: ((snapshot: NativeNetworkSnapshot) => void) | null = null;
  let reachable = true;
  let probes = 0;
  let backOnline = 0;

  const monitor = createNetworkMonitor({
    subscribeNative: (l) => {
      listener = l;
      return () => {
        listener = null;
      };
    },
    probe: () => {
      probes += 1;
      if (options.failProbe) {
        return Promise.reject(new Error('sonde cassée'));
      }
      return Promise.resolve(reachable);
    },
    onBackOnline: () => {
      backOnline += 1;
    },
  });

  monitor.start();

  return {
    monitor,
    emitNative: (snapshot) => listener?.(snapshot),
    setReachable: (value) => {
      reachable = value;
    },
    probeCount: () => probes,
    backOnlineCount: () => backOnline,
  };
}

const WIFI: NativeNetworkSnapshot = {
  isConnected: true,
  connectionType: 'wifi',
  isMetered: false,
};
const CELLULAR: NativeNetworkSnapshot = {
  isConnected: true,
  connectionType: 'cellular',
  isMetered: true,
};
const NONE: NativeNetworkSnapshot = {
  isConnected: false,
  connectionType: 'none',
  isMetered: false,
};

describe('surveillance réseau', () => {
  it('passe hors ligne dès la coupure', async () => {
    const h = createHarness();
    h.emitNative(WIFI);
    await vi.waitFor(() => expect(h.monitor.getState().status).toBe('online'));

    h.emitNative(NONE);
    // Le mode avion doit se voir tout de suite, pas après une temporisation.
    expect(h.monitor.getState().status).toBe('offline');
  });

  it('ne sonde pas quand il n’y a aucun réseau', async () => {
    const h = createHarness();
    h.emitNative(WIFI);
    await vi.waitFor(() => expect(h.monitor.getState().status).toBe('online'));
    const before = h.probeCount();

    h.emitNative(NONE);
    await vi.waitFor(() => expect(h.monitor.getState().status).toBe('offline'));

    // La réponse est connue d'avance : une requête vouée à l'échec coûterait
    // de la batterie pour rien.
    expect(h.probeCount()).toBe(before);
  });

  it('distingue un portail captif d’une absence de réseau', async () => {
    const h = createHarness();
    h.setReachable(false);

    // Le réseau se déclare connecté, mais le serveur ne répond pas.
    h.emitNative(WIFI);
    await vi.waitFor(() => expect(h.monitor.getState().status).toBe('limited'));

    // Surtout pas « offline » : l'utilisateur doit savoir que son Wi-Fi
    // fonctionne mais que quelque chose bloque.
    expect(h.monitor.getState().status).not.toBe('offline');
    expect(h.monitor.getState().connectionType).toBe('wifi');
  });

  it('traite une sonde qui lève comme un serveur injoignable', async () => {
    const h = createHarness({ failProbe: true });
    h.emitNative(WIFI);

    // Une exception ne doit jamais faire tomber la surveillance.
    await vi.waitFor(() => expect(h.monitor.getState().status).toBe('limited'));
  });

  it('réessaie périodiquement tant que le serveur ne répond pas', async () => {
    vi.useFakeTimers();
    try {
      const h = createHarness();
      h.setReachable(false);

      h.emitNative(WIFI);
      await vi.advanceTimersByTimeAsync(0);
      expect(h.monitor.getState().status).toBe('limited');

      const before = h.probeCount();
      await vi.advanceTimersByTimeAsync(DEFAULT_LIMITED_RETRY_MS);
      expect(h.probeCount()).toBeGreaterThan(before);

      // Le serveur revient : la sonde suivante doit conclure.
      h.setReachable(true);
      await vi.advanceTimersByTimeAsync(DEFAULT_LIMITED_RETRY_MS);
      expect(h.monitor.getState().status).toBe('online');
    } finally {
      vi.useRealTimers();
    }
  });

  it('cesse de sonder une fois la connexion rétablie', async () => {
    vi.useFakeTimers();
    try {
      const h = createHarness();
      h.emitNative(WIFI);
      await vi.advanceTimersByTimeAsync(0);
      expect(h.monitor.getState().status).toBe('online');

      const before = h.probeCount();
      await vi.advanceTimersByTimeAsync(DEFAULT_LIMITED_RETRY_MS * 5);

      // Sonder en boucle alors que tout fonctionne dépenserait le forfait pour
      // confirmer ce qu'on sait déjà.
      expect(h.probeCount()).toBe(before);
    } finally {
      vi.useRealTimers();
    }
  });

  it('déclenche le vidage de la file au retour de la connexion', async () => {
    const h = createHarness();
    h.setReachable(false);
    h.emitNative(WIFI);
    await vi.waitFor(() => expect(h.monitor.getState().status).toBe('limited'));
    expect(h.backOnlineCount()).toBe(0);

    h.setReachable(true);
    await h.monitor.check();

    // C'est le déclencheur utile : celui qui fait partir les messages écrits
    // pendant la coupure (#54).
    expect(h.backOnlineCount()).toBe(1);
  });

  it('ne déclenche pas deux fois si la connexion reste établie', async () => {
    const h = createHarness();
    h.emitNative(WIFI);
    await vi.waitFor(() => expect(h.monitor.getState().status).toBe('online'));

    await h.monitor.check();
    await h.monitor.check();

    expect(h.backOnlineCount()).toBe(1);
  });

  it('marque une connexion mobile comme facturée', async () => {
    const h = createHarness();
    h.emitNative(CELLULAR);
    await vi.waitFor(() => expect(h.monitor.getState().status).toBe('online'));

    expect(h.monitor.getState().isMetered).toBe(true);
    expect(h.monitor.getState().connectionType).toBe('cellular');
  });

  it('croit la plateforme quand elle signale un partage de connexion', async () => {
    const h = createHarness();
    // Un partage de connexion se présente comme du Wi-Fi tout en consommant le
    // forfait mobile de quelqu'un.
    h.emitNative({ isConnected: true, connectionType: 'wifi', isMetered: true });
    await vi.waitFor(() => expect(h.monitor.getState().status).toBe('online'));

    expect(h.monitor.getState().isMetered).toBe(true);
  });

  it('ignore une sonde périmée revenue après une plus récente', async () => {
    // Objets mutables plutôt que variables : l'analyse de flux de TypeScript ne
    // voit pas les assignations faites dans un callback.
    const captured: { listener: ((s: NativeNetworkSnapshot) => void) | null } = {
      listener: null,
    };
    const resolvers: ((value: boolean) => void)[] = [];

    const monitor = createNetworkMonitor({
      subscribeNative: (l) => {
        captured.listener = l;
        return () => {
          captured.listener = null;
        };
      },
      probe: () =>
        new Promise<boolean>((resolve) => {
          resolvers.push(resolve);
        }),
    });
    monitor.start();

    // Une connexion apparaît : la sonde nº 1 part et reste en suspens, comme
    // sur un réseau qui traîne.
    captured.listener?.(WIFI);
    await vi.waitFor(() => expect(resolvers).toHaveLength(1));

    // Une seconde vérification part et conclut avant la première.
    const second = monitor.check();
    await vi.waitFor(() => expect(resolvers).toHaveLength(2));
    resolvers[1]?.(true);
    await second;
    expect(monitor.getState().status).toBe('online');

    // La sonde nº 1 revient enfin, avec un verdict désormais périmé.
    resolvers[0]?.(false);
    await Promise.resolve();

    // Elle ne doit pas rétrograder un état déjà conclu par une sonde plus
    // récente : sinon l'application afficherait « hors ligne » alors qu'elle
    // vient de se reconnecter.
    expect(monitor.getState().status).toBe('online');
  });

  it('arrête toute sonde après stop()', async () => {
    vi.useFakeTimers();
    try {
      const h = createHarness();
      h.setReachable(false);
      h.emitNative(WIFI);
      await vi.advanceTimersByTimeAsync(0);
      expect(h.monitor.getState().status).toBe('limited');

      h.monitor.stop();
      const before = h.probeCount();
      await vi.advanceTimersByTimeAsync(DEFAULT_LIMITED_RETRY_MS * 3);

      expect(h.probeCount()).toBe(before);
    } finally {
      vi.useRealTimers();
    }
  });

  it('notifie les abonnés et se désabonne proprement', async () => {
    const h = createHarness();
    const seen: string[] = [];
    const stop = h.monitor.subscribe((state) => seen.push(state.status));

    h.emitNative(WIFI);
    await vi.waitFor(() => expect(seen).toContain('online'));

    stop();
    const before = seen.length;
    h.emitNative(NONE);
    expect(seen).toHaveLength(before);
  });
});

describe('bandeau', () => {
  const base: NetworkState = {
    status: 'online',
    connectionType: 'wifi',
    isMetered: false,
    isSyncing: false,
    pendingCount: 0,
  };

  it('ne montre rien quand tout va bien', () => {
    // Un état normal n'a pas besoin d'être commenté.
    expect(bannerFor(base)).toBe('none');
  });

  it('annonce la coupure', () => {
    expect(bannerFor({ ...base, status: 'offline', connectionType: 'none' })).toBe('offline');
  });

  it('distingue le réseau sans accès', () => {
    expect(bannerFor({ ...base, status: 'limited' })).toBe('limited');
  });

  it('reste muet pendant la première vérification au démarrage', () => {
    // Sinon l'application clignote « hors ligne » à chaque ouverture.
    expect(bannerFor({ ...base, status: 'reconnecting' })).toBe('none');
  });

  it('annonce la reconnexion s’il y a des messages en attente', () => {
    expect(bannerFor({ ...base, status: 'reconnecting', pendingCount: 3 })).toBe('reconnecting');
  });

  it('annonce la synchronisation seulement s’il reste des messages à envoyer', () => {
    expect(bannerFor({ ...base, isSyncing: true, pendingCount: 2 })).toBe('syncing');
    expect(bannerFor({ ...base, isSyncing: true, pendingCount: 0 })).toBe('none');
  });

  it('laisse toujours écrire, quel que soit l’état', () => {
    // Le composeur ne se désactive JAMAIS : un message rédigé hors ligne est
    // mis en file et part au retour du réseau (ADR-0002).
    for (const status of ['offline', 'limited', 'reconnecting', 'online'] as const) {
      expect(canCompose({ ...base, status })).toBe(true);
    }
  });
});
