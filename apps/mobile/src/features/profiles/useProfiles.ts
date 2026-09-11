import { useState } from 'react';

import { getDatabase } from '../../db/client';
import { profiles as profilesTable } from '../../db/schema';
import type { ProfileSummary } from '../conversations/rows';

/**
 * Profils connus localement, indexés par identifiant.
 *
 * Lecture locale : la liste des conversations a besoin des noms pour s'afficher,
 * et elle doit s'afficher hors ligne. Les profils arrivent par la
 * synchronisation, jamais à la demande depuis un écran.
 */
export function useProfiles(): ReadonlyMap<string, ProfileSummary> {
  // Lecture synchrone au premier rendu plutôt que dans un effet : SQLite est
  // local, il n'y a rien à attendre, et un `setState` synchrone dans un effet
  // provoque un rendu en cascade pour rien.
  //
  // Les profils ne se rafraîchissent donc pas d'eux-mêmes. C'est acceptable
  // tant que la synchronisation ne les met pas à jour en cours de session
  // (#53) ; le jour où elle le fera, ce hook devra s'abonner.
  const [profiles] = useState<ReadonlyMap<string, ProfileSummary>>(() => {
    const rows = getDatabase().select().from(profilesTable).all();

    return new Map(
      rows.map((row) => [
        row.id,
        {
          id: row.id,
          displayName: row.displayName,
          username: row.username,
          avatarUrl: row.avatarUrl,
        },
      ]),
    );
  });

  return profiles;
}

// `useCurrentUserId` vivait ici en provisoire ; il vient maintenant de la
// session réelle (#23).
export { useCurrentUserId } from '../auth/session';
