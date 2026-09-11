import { useEffect, useState } from 'react';

import { getClient, hasClient } from '@kola/api';

/**
 * Disponibilité d'un pseudo, vérifiée en direct (#22).
 *
 * Deux précautions, toutes deux dictées par le coût des données :
 *
 *   * la vérification est **temporisée**. Une requête par frappe serait
 *     inacceptable sur un réseau facturé au mégaoctet ;
 *   * elle est **annulable**. Une réponse tardive concernant un pseudo déjà
 *     remplacé afficherait « déjà pris » pour un mot que l'utilisateur ne tape
 *     plus.
 *
 * L'unicité réelle reste garantie par la contrainte en base (#8) : ceci n'est
 * qu'un confort, et la course finale est tranchée à l'enregistrement.
 */

export const AVAILABILITY_DEBOUNCE_MS = 400;

export type AvailabilityState = 'idle' | 'checking' | 'available' | 'taken' | 'unknown';

export interface AvailabilityResult {
  readonly state: AvailabilityState;
}

export function useUsernameAvailability(username: string | null): AvailabilityResult {
  // Seul le verdict du serveur est stocké, avec le pseudo auquel il se
  // rapporte. Le reste — « au repos », « en cours », « inconnu » — se déduit du
  // paramètre pendant le rendu, ce qui évite tout setState dans un effet.
  const [checked, setChecked] = useState<{ username: string; taken: boolean } | null>(null);
  const [failed, setFailed] = useState<string | null>(null);

  useEffect(() => {
    if (username === null || username === '' || !hasClient()) {
      return;
    }

    let cancelled = false;

    const timer = setTimeout(() => {
      void getClient()
        .from('profiles')
        .select('id')
        .eq('username', username)
        .maybeSingle()
        .then(({ data, error }) => {
          if (cancelled) {
            return;
          }
          if (error) {
            setFailed(username);
            return;
          }
          setChecked({ username, taken: data !== null });
        });
    }, AVAILABILITY_DEBOUNCE_MS);

    return () => {
      // Annule la requête en vol comme la temporisation en attente : une
      // réponse tardive afficherait « déjà pris » pour un pseudo que
      // l'utilisateur ne tape plus.
      cancelled = true;
      clearTimeout(timer);
    };
  }, [username]);

  if (username === null || username === '') {
    return { state: 'idle' };
  }
  if (!hasClient()) {
    // Hors ligne, ou projet non câblé : on ne prétend pas savoir.
    return { state: 'unknown' };
  }
  if (failed === username) {
    return { state: 'unknown' };
  }
  if (checked?.username === username) {
    return { state: checked.taken ? 'taken' : 'available' };
  }
  return { state: 'checking' };
}
