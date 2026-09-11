import type { ReachabilityProbe } from './monitor';

/**
 * Sonde de joignabilité.
 *
 * Elle répond à la seule question qui compte : le serveur répond-il ? La
 * détection native, elle, ne sait dire que « un réseau existe » — ce qui reste
 * vrai derrière un portail captif d'hôtel ou de cybercafé.
 *
 * Trois contraintes, toutes dictées par le coût des données :
 *
 *   * la réponse doit être **minuscule**. On interroge un point d'entrée qui
 *     répond quelques octets, jamais une page ni une requête de données ;
 *   * il y a un **délai maximal court**. Sur un réseau dégradé, une requête
 *     peut rester en suspens des minutes : au-delà du délai, on considère le
 *     serveur injoignable plutôt que d'attendre ;
 *   * elle est **espacée**. C'est le rôle de la surveillance, qui ne l'appelle
 *     qu'au changement d'état et tant que la connexion reste inexploitable.
 */

export const DEFAULT_PROBE_TIMEOUT_MS = 5_000;

export interface ProbeOptions {
  /** Point d'entrée interrogé. Doit répondre court et sans authentification. */
  readonly url: string;
  readonly timeoutMs?: number;
  readonly fetch?: typeof globalThis.fetch;
}

export function createReachabilityProbe(options: ProbeOptions): ReachabilityProbe {
  const timeoutMs = options.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
  const doFetch = options.fetch ?? globalThis.fetch;

  return async () => {
    const controller = new AbortController();
    const timer = globalThis.setTimeout(() => {
      controller.abort();
    }, timeoutMs);

    try {
      const response = await doFetch(options.url, {
        method: 'HEAD',
        signal: controller.signal,
        // Un cache intermédiaire répondrait « tout va bien » sans que rien
        // n'ait quitté l'appareil : la sonde ne mesurerait plus rien.
        cache: 'no-store',
      });

      // Toute réponse HTTP prouve que le serveur est là, y compris un 401 ou un
      // 404 : ce qu'on teste, c'est la joignabilité, pas l'autorisation. Un
      // portail captif, lui, ne répond pas du tout ou détourne la requête.
      return response.status < 500;
    } catch {
      // Délai dépassé, DNS muet, connexion refusée : injoignable.
      return false;
    } finally {
      globalThis.clearTimeout(timer);
    }
  };
}
