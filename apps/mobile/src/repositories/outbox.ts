import { and, asc, eq, lte, sql } from 'drizzle-orm';

import { computeBackoffMs, isPermanentFailure, OUTBOX_BACKOFF } from '@kola/core';
import type { OutboxItem, OutboxOperation } from '@kola/core';

import { outbox } from '../db/schema';

import type { LocalDatabase, Transaction } from './database';

/**
 * File d'attente sortante.
 *
 * Pendant en écriture de la synchronisation par curseur, et cœur de la promesse
 * « rédiger hors ligne » (ADR-0002). Le moteur qui la vide arrive en #54 ; ce
 * module ne porte que la file elle-même, pour que l'écriture puisse être mise
 * en attente dès maintenant.
 */

export interface EnqueueInput {
  readonly operation: OutboxOperation;
  readonly entityId: string;
  readonly conversationId?: string | null;
  readonly payload: unknown;
}

/**
 * Met une opération en file.
 *
 * **Doit être appelée dans la même transaction que l'écriture métier.** Une
 * insertion réussie avec une mise en file échouée produirait un message qui ne
 * partirait jamais, sans que rien ne le signale.
 *
 * En cas de doublon (même opération, même entité), la charge utile la plus
 * récente écrase l'ancienne et les compteurs repartent à zéro : deux éditions
 * successives du même message ne doivent pas produire deux envois, et la
 * dernière valeur est la bonne.
 */
export function enqueue(tx: Transaction | LocalDatabase, input: EnqueueInput, at: number): void {
  tx.insert(outbox)
    .values({
      operation: input.operation,
      entityId: input.entityId,
      conversationId: input.conversationId ?? null,
      payload: JSON.stringify(input.payload),
      retryCount: 0,
      nextAttemptAt: at,
      lastError: null,
      createdAt: at,
    })
    .onConflictDoUpdate({
      target: [outbox.operation, outbox.entityId],
      set: {
        payload: sql`excluded.payload`,
        retryCount: 0,
        nextAttemptAt: at,
        lastError: null,
      },
    })
    .run();
}

/** Retire une entrée de la file, par exemple après un envoi confirmé. */
export function dequeue(
  tx: Transaction | LocalDatabase,
  operation: OutboxOperation,
  entityId: string,
): void {
  tx.delete(outbox)
    .where(and(eq(outbox.operation, operation), eq(outbox.entityId, entityId)))
    .run();
}

function toItem(row: typeof outbox.$inferSelect): OutboxItem {
  return {
    id: row.id,
    operation: row.operation as OutboxOperation,
    entityId: row.entityId,
    conversationId: row.conversationId,
    payload: JSON.parse(row.payload) as unknown,
    retryCount: row.retryCount,
    nextAttemptAt: row.nextAttemptAt,
    lastError: row.lastError,
    createdAt: row.createdAt,
  };
}

/**
 * Entrées prêtes à être envoyées, dans l'ordre d'insertion.
 *
 * L'ordre compte : vingt messages envoyés hors ligne doivent partir dans
 * l'ordre où ils ont été écrits, pas dans un ordre arbitraire.
 */
export function pending(db: LocalDatabase, now: number, limit = 50): readonly OutboxItem[] {
  return db
    .select()
    .from(outbox)
    .where(lte(outbox.nextAttemptAt, now))
    .orderBy(asc(outbox.id))
    .limit(limit)
    .all()
    .map(toItem);
}

export function count(db: LocalDatabase): number {
  const row = db
    .select({ value: sql<number>`count(*)` })
    .from(outbox)
    .get();
  return row?.value ?? 0;
}

export interface FailureOutcome {
  /** L'entrée est abandonnée : le message passe en échec, avec relance manuelle. */
  readonly abandoned: boolean;
  readonly retryCount: number;
  readonly nextAttemptAt: number | null;
}

/**
 * Enregistre l'échec d'une tentative et programme la suivante.
 *
 * Deux cas mènent à l'abandon : une erreur définitive (4xx), et l'épuisement du
 * nombre de tentatives. Dans les deux cas, l'entrée quitte la file et le
 * message passe en échec — c'est à l'utilisateur de décider de relancer.
 */
export function recordFailure(
  db: LocalDatabase,
  item: OutboxItem,
  error: { readonly status?: number | null; readonly message: string },
  now: number,
  random: () => number = Math.random,
): FailureOutcome {
  const retryCount = item.retryCount + 1;
  const permanent = isPermanentFailure(error.status);
  const exhausted = retryCount >= OUTBOX_BACKOFF.maxRetries;

  if (permanent || exhausted) {
    dequeue(db, item.operation, item.entityId);
    return { abandoned: true, retryCount, nextAttemptAt: null };
  }

  const nextAttemptAt = now + computeBackoffMs(retryCount, random);

  db.update(outbox)
    .set({ retryCount, nextAttemptAt, lastError: error.message })
    .where(eq(outbox.id, item.id))
    .run();

  return { abandoned: false, retryCount, nextAttemptAt };
}
