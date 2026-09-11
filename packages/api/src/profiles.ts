import type { KolaClient } from './client';
import { toTransportError } from './transport-errors';

/**
 * Recherche de personnes (#37).
 *
 * Chercher quelqu'un est, par nature, une opération en ligne : on interroge un
 * annuaire qu'on n'a pas. C'est la seule exception au local-first de l'ADR-0002,
 * et elle est bornée — l'écran qui l'utilise reste utilisable hors ligne, il ne
 * propose alors que les personnes déjà connues de la base locale.
 *
 * La découverte par carnet d'adresses arrive en #68. En attendant, on cherche
 * par pseudo, unique depuis #22.
 */

export interface ProfileMatch {
  readonly id: string;
  readonly username: string;
  readonly displayName: string | null;
  readonly avatarUrl: string | null;
}

export async function searchProfiles(
  supabase: KolaClient,
  query: string,
  limit = 20,
): Promise<readonly ProfileMatch[]> {
  const trimmed = query.trim();
  // Deux caractères au minimum : à une lettre, la recherche rend la moitié de
  // l'annuaire pour un résultat inutile, sur un forfait qui se compte.
  if (trimmed.length < 2) {
    return [];
  }

  const { data, error } = await supabase.rpc('search_profiles', {
    query: trimmed,
    max_results: limit,
  });

  if (error) {
    throw toTransportError(error);
  }

  return (data ?? []).map((row) => ({
    id: row.id,
    username: row.username ?? '',
    displayName: row.display_name,
    avatarUrl: row.avatar_url,
  }));
}
