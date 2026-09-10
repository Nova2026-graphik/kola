import { getClient, hasClient } from '@kola/api';

import { getDatabase } from '../../db/client';
import { profiles } from '../../db/schema';

/**
 * Enregistrement du profil (#22).
 *
 * Écriture locale d'abord, puis serveur — dans cet ordre, conformément au
 * local-first (ADR-0002). Hors ligne, le profil est valable localement et
 * l'application reste utilisable ; la propagation se fera à la reconnexion.
 *
 * L'unicité du pseudo est garantie par la contrainte en base (#8) : la
 * vérification en direct de l'écran n'est qu'un confort, et une course reste
 * possible jusqu'ici.
 */

export interface SaveProfileInput {
  readonly userId: string;
  readonly username: string;
  readonly displayName: string;
  readonly bio: string | null;
}

export type SaveProfileError = 'username-taken' | 'network' | 'unknown';

export interface SaveProfileResult {
  readonly ok: boolean;
  readonly error?: SaveProfileError;
}

export async function saveProfile(input: SaveProfileInput): Promise<SaveProfileResult> {
  const now = Date.now();

  // 1. Local, immédiatement : l'écran suivant doit pouvoir afficher le profil
  //    même si le réseau ne répond pas.
  getDatabase()
    .insert(profiles)
    .values({
      id: input.userId,
      username: input.username,
      displayName: input.displayName,
      bio: input.bio,
      createdAt: now,
    })
    .onConflictDoUpdate({
      target: profiles.id,
      set: {
        username: input.username,
        displayName: input.displayName,
        bio: input.bio,
      },
    })
    .run();

  if (!hasClient()) {
    return { ok: true };
  }

  // 2. Serveur.
  const { error } = await getClient()
    .from('profiles')
    .update({
      username: input.username,
      display_name: input.displayName,
      bio: input.bio,
    })
    .eq('id', input.userId);

  if (!error) {
    return { ok: true };
  }

  // 23505 : violation d'unicité. La course a été perdue entre la vérification
  // en direct et l'enregistrement — c'est le seul verdict qui fait autorité.
  if (error.code === '23505') {
    return { ok: false, error: 'username-taken' };
  }

  // Le profil local reste valable : la propagation sera reprise plus tard.
  return { ok: false, error: 'network' };
}
