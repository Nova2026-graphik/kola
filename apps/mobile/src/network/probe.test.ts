import { describe, expect, it, vi } from 'vitest';

import { createReachabilityProbe } from './probe';

const URL = 'https://exemple.test/health';

function responseWith(status: number): Response {
  return { status } as Response;
}

describe('sonde de joignabilité', () => {
  it('conclut que le serveur répond', async () => {
    const probe = createReachabilityProbe({
      url: URL,
      fetch: () => Promise.resolve(responseWith(200)),
    });

    await expect(probe()).resolves.toBe(true);
  });

  it('accepte un refus d’autorisation comme preuve de joignabilité', async () => {
    // Ce qu'on teste est la joignabilité, pas l'autorisation : un 401 prouve
    // qu'il y a bien un serveur au bout du fil.
    const probe = createReachabilityProbe({
      url: URL,
      fetch: () => Promise.resolve(responseWith(401)),
    });

    await expect(probe()).resolves.toBe(true);
  });

  it('conclut à l’injoignabilité sur une panne serveur', async () => {
    const probe = createReachabilityProbe({
      url: URL,
      fetch: () => Promise.resolve(responseWith(503)),
    });

    await expect(probe()).resolves.toBe(false);
  });

  it('conclut à l’injoignabilité quand la requête échoue', async () => {
    const probe = createReachabilityProbe({
      url: URL,
      fetch: () => Promise.reject(new Error('DNS muet')),
    });

    // Ne doit jamais lever : la surveillance s'arrêterait.
    await expect(probe()).resolves.toBe(false);
  });

  it('abandonne au-delà du délai plutôt que d’attendre indéfiniment', async () => {
    vi.useFakeTimers();
    try {
      const probe = createReachabilityProbe({
        url: URL,
        timeoutMs: 1_000,
        // Sur un réseau dégradé, une requête peut rester en suspens des minutes.
        fetch: (_input, init) =>
          new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () => {
              reject(new Error('aborted'));
            });
          }),
      });

      const result = probe();
      await vi.advanceTimersByTimeAsync(1_000);

      await expect(result).resolves.toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('interroge le serveur en HEAD, sans cache', async () => {
    const calls: RequestInit[] = [];
    const probe = createReachabilityProbe({
      url: URL,
      fetch: (_input, init) => {
        calls.push(init ?? {});
        return Promise.resolve(responseWith(200));
      },
    });

    await probe();

    // Une réponse minuscule, et surtout jamais servie par un cache : sinon la
    // sonde répondrait « tout va bien » sans que rien n'ait quitté l'appareil.
    expect(calls[0]?.method).toBe('HEAD');
    expect(calls[0]?.cache).toBe('no-store');
  });
});
