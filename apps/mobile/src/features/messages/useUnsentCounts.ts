import { and, eq, isNull, sql } from 'drizzle-orm';
import { useCallback, useEffect, useState } from 'react';

import { getDatabase } from '../../db/client';
import { messages } from '../../db/schema';
import { getRepositories } from '../../repositories';

/**
 * Nombre de messages écrits mais pas encore partis (#32).
 *
 * Alimente le bandeau récapitulatif. Les deux compteurs sont distincts parce
 * qu'ils appellent des réactions différentes : une attente se règle toute
 * seule au retour du réseau, un échec demande une action de l'utilisateur.
 */

export interface UnsentCounts {
  readonly pending: number;
  readonly failed: number;
}

const EMPTY: UnsentCounts = { pending: 0, failed: 0 };

function countFor(conversationId: string | undefined, status: 'pending' | 'failed'): number {
  const row = getDatabase()
    .select({ value: sql<number>`count(*)` })
    .from(messages)
    .where(
      and(
        eq(messages.syncStatus, status),
        // Un message supprimé n'a plus à être envoyé : le compter inquiéterait
        // pour rien.
        isNull(messages.deletedAt),
        ...(conversationId === undefined ? [] : [eq(messages.conversationId, conversationId)]),
      ),
    )
    .get();

  return row?.value ?? 0;
}

/** Omettre `conversationId` compte sur toute l'application. */
export function useUnsentCounts(conversationId?: string): UnsentCounts {
  const [counts, setCounts] = useState<UnsentCounts>(() => ({
    pending: countFor(conversationId, 'pending'),
    failed: countFor(conversationId, 'failed'),
  }));

  const refresh = useCallback(() => {
    setCounts({
      pending: countFor(conversationId, 'pending'),
      failed: countFor(conversationId, 'failed'),
    });
  }, [conversationId]);

  useEffect(() => {
    if (conversationId === undefined) {
      return;
    }
    // Le repository notifie à chaque écriture locale : le bandeau suit sans
    // interroger la base en boucle.
    return getRepositories().messages.subscribe(conversationId, refresh);
  }, [conversationId, refresh]);

  return conversationId === undefined ? EMPTY : counts;
}
