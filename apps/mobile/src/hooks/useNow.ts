import { useEffect, useState } from 'react';

/**
 * Instant courant, rafraîchi périodiquement.
 *
 * Deux raisons de ne pas appeler `Date.now()` directement dans le rendu :
 *
 *   * le rendu doit être **pur**. Une valeur qui change à chaque appel rend le
 *     résultat non déterministe et casse toute mémoïsation qui en dépend ;
 *   * les horodatages relatifs doivent quand même **suivre le temps**. Un
 *     message affiché « 14:29 » à 23 h 59 doit passer à « Hier » à minuit,
 *     sans que l'utilisateur ait à quitter l'écran.
 *
 * La minute est le bon pas : c'est la plus petite unité qu'affiche l'interface,
 * et un minuteur plus serré réveillerait le processeur pour rien.
 */
export const DEFAULT_TICK_MS = 60_000;

export function useNow(intervalMs: number = DEFAULT_TICK_MS): number {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const id = setInterval(() => {
      setNow(Date.now());
    }, intervalMs);

    return () => {
      clearInterval(id);
    };
  }, [intervalMs]);

  return now;
}
