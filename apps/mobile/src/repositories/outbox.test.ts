import { beforeEach, describe, expect, it } from 'vitest';

import { computeBackoffMs, isPermanentFailure, OUTBOX_BACKOFF } from '@kola/core';
import type { OutboxItem } from '@kola/core';

import { createClock, createTestDatabase } from '../db/testing';

import type { LocalDatabase } from './database';
import { count, dequeue, enqueue, pending, recordFailure } from './outbox';

/**
 * Tests de la file d'attente sortante.
 *
 * C'est le composant dont les bugs sont les plus coûteux et les plus difficiles
 * à reproduire : ils n'apparaissent qu'après une coupure au mauvais moment,
 * chez un utilisateur, sans trace exploitable (ADR-0002).
 */

describe('temporisation', () => {
  it('croît exponentiellement', () => {
    const noJitter = () => 0.5; // centre exact, aucun décalage
    expect(computeBackoffMs(0, noJitter)).toBe(1_000);
    expect(computeBackoffMs(1, noJitter)).toBe(2_000);
    expect(computeBackoffMs(2, noJitter)).toBe(4_000);
    expect(computeBackoffMs(5, noJitter)).toBe(32_000);
  });

  it('est plafonnée', () => {
    const noJitter = () => 0.5;
    // Sans plafond, la 20e tentative attendrait plus de douze jours.
    expect(computeBackoffMs(20, noJitter)).toBe(OUTBOX_BACKOFF.maxMs);
  });

  it('comporte une part d’aléatoire', () => {
    // Sans elle, tous les clients d'une même zone se reconnectent à la même
    // seconde après un rétablissement de réseau et refont converger la charge.
    const low = computeBackoffMs(3, () => 0);
    const high = computeBackoffMs(3, () => 1);
    expect(low).toBeLessThan(high);
    expect(low).toBeGreaterThanOrEqual(0);
  });

  it('ne produit jamais de délai négatif', () => {
    for (let retry = 0; retry < 10; retry += 1) {
      expect(computeBackoffMs(retry, () => 0)).toBeGreaterThanOrEqual(0);
    }
  });
});

describe('classification des erreurs', () => {
  it('abandonne sur une erreur définitive', () => {
    // Réessayer indéfiniment un refus RLS épuise la batterie et le forfait sans
    // jamais aboutir.
    expect(isPermanentFailure(401)).toBe(true);
    expect(isPermanentFailure(403)).toBe(true);
    expect(isPermanentFailure(404)).toBe(true);
    expect(isPermanentFailure(422)).toBe(true);
  });

  it('réessaie sur une erreur transitoire', () => {
    expect(isPermanentFailure(500)).toBe(false);
    expect(isPermanentFailure(503)).toBe(false);
    // Pas de réponse du tout : coupure réseau.
    expect(isPermanentFailure(null)).toBe(false);
    expect(isPermanentFailure(undefined)).toBe(false);
  });

  it('réessaie sur les 4xx qui demandent explicitement de réessayer', () => {
    expect(isPermanentFailure(408)).toBe(false); // délai dépassé
    expect(isPermanentFailure(429)).toBe(false); // débit limité
  });
});

describe('file d’attente', () => {
  let db: LocalDatabase;
  let close: () => void;
  let clock: ReturnType<typeof createClock>;

  beforeEach(() => {
    const test = createTestDatabase();
    db = test.db;
    close = test.close;
    clock = createClock();
    return () => close();
  });

  it('rend les entrées dans l’ordre d’insertion', () => {
    for (let i = 1; i <= 5; i += 1) {
      enqueue(db, { operation: 'send_message', entityId: `m${i}`, payload: { i } }, clock.now());
    }

    const queued = pending(db, clock.now());
    // Vingt messages envoyés hors ligne doivent partir dans l'ordre où ils ont
    // été écrits, pas dans un ordre arbitraire.
    expect(queued.map((q) => q.entityId)).toEqual(['m1', 'm2', 'm3', 'm4', 'm5']);
  });

  it('ne rend pas les entrées dont l’heure n’est pas venue', () => {
    enqueue(db, { operation: 'send_message', entityId: 'm1', payload: {} }, clock.now());
    enqueue(db, { operation: 'send_message', entityId: 'm2', payload: {} }, clock.now() + 60_000);

    expect(pending(db, clock.now()).map((q) => q.entityId)).toEqual(['m1']);

    clock.advance(60_000);
    expect(pending(db, clock.now()).map((q) => q.entityId)).toEqual(['m1', 'm2']);
  });

  it('remplace au lieu d’empiler quand la même entité revient', () => {
    enqueue(
      db,
      { operation: 'send_message', entityId: 'm1', payload: { body: 'v1' } },
      clock.now(),
    );
    enqueue(
      db,
      { operation: 'send_message', entityId: 'm1', payload: { body: 'v2' } },
      clock.now(),
    );

    const queued = pending(db, clock.now());
    expect(queued).toHaveLength(1);
    // La dernière valeur est la bonne : deux éditions successives du même
    // message ne doivent pas produire deux envois.
    expect((queued[0]?.payload as { body: string }).body).toBe('v2');
  });

  it('distingue deux opérations sur la même entité', () => {
    enqueue(db, { operation: 'send_message', entityId: 'm1', payload: {} }, clock.now());
    enqueue(db, { operation: 'delete_message', entityId: 'm1', payload: {} }, clock.now());

    expect(count(db)).toBe(2);
  });

  it('retire une entrée traitée', () => {
    enqueue(db, { operation: 'send_message', entityId: 'm1', payload: {} }, clock.now());
    dequeue(db, 'send_message', 'm1');
    expect(count(db)).toBe(0);
  });

  it('sérialise et restitue la charge utile', () => {
    enqueue(
      db,
      {
        operation: 'send_message',
        entityId: 'm1',
        conversationId: 'conv-1',
        payload: { body: 'Bonjour', replyToId: null, nested: { ok: true } },
      },
      clock.now(),
    );

    const item = pending(db, clock.now())[0];
    expect(item?.conversationId).toBe('conv-1');
    expect(item?.payload).toEqual({ body: 'Bonjour', replyToId: null, nested: { ok: true } });
  });
});

describe('échecs d’envoi', () => {
  let db: LocalDatabase;
  let close: () => void;
  let clock: ReturnType<typeof createClock>;

  function firstItem(): OutboxItem {
    const item = pending(db, clock.now())[0];
    if (!item) {
      throw new Error('file vide');
    }
    return item;
  }

  beforeEach(() => {
    const test = createTestDatabase();
    db = test.db;
    close = test.close;
    clock = createClock();
    enqueue(db, { operation: 'send_message', entityId: 'm1', payload: {} }, clock.now());
    return () => close();
  });

  it('reprogramme une tentative après une erreur transitoire', () => {
    const outcome = recordFailure(
      db,
      firstItem(),
      { status: 503, message: 'service indisponible' },
      clock.now(),
      () => 0.5,
    );

    expect(outcome.abandoned).toBe(false);
    expect(outcome.retryCount).toBe(1);
    expect(outcome.nextAttemptAt).toBe(clock.now() + 2_000);

    // L'entrée reste en file, mais n'est plus éligible tout de suite.
    expect(count(db)).toBe(1);
    expect(pending(db, clock.now())).toHaveLength(0);
  });

  it('conserve le message d’erreur pour le diagnostic', () => {
    recordFailure(db, firstItem(), { status: 500, message: 'boum' }, clock.now(), () => 0.5);
    clock.advance(10_000);
    expect(firstItem().lastError).toBe('boum');
  });

  it('abandonne immédiatement sur une erreur définitive', () => {
    const outcome = recordFailure(
      db,
      firstItem(),
      { status: 403, message: 'accès refusé' },
      clock.now(),
    );

    expect(outcome.abandoned).toBe(true);
    // L'entrée quitte la file : c'est à l'utilisateur de décider de relancer.
    expect(count(db)).toBe(0);
  });

  it('abandonne après épuisement des tentatives', () => {
    let outcome = recordFailure(db, firstItem(), { status: 500, message: 'boum' }, clock.now());

    for (let i = 1; i < OUTBOX_BACKOFF.maxRetries; i += 1) {
      expect(outcome.abandoned).toBe(false);
      clock.advance(OUTBOX_BACKOFF.maxMs);
      outcome = recordFailure(db, firstItem(), { status: 500, message: 'boum' }, clock.now());
    }

    expect(outcome.abandoned).toBe(true);
    expect(outcome.retryCount).toBe(OUTBOX_BACKOFF.maxRetries);
    expect(count(db)).toBe(0);
  });

  it('survit à cent cycles de coupure sans perdre ni dupliquer', () => {
    // Le scénario que l'utilisateur vivra réellement : le réseau va et vient,
    // l'outbox réessaie, et rien ne doit se perdre ni se dédoubler.
    const test = createTestDatabase();
    try {
      for (let i = 1; i <= 100; i += 1) {
        enqueue(
          test.db,
          { operation: 'send_message', entityId: 'm-unique', payload: { attempt: i } },
          clock.now(),
        );
      }

      // Cent mises en file de la même entité : une seule entrée.
      expect(count(test.db)).toBe(1);
      const item = pending(test.db, clock.now())[0];
      expect((item?.payload as { attempt: number }).attempt).toBe(100);
    } finally {
      test.close();
    }
  });
});
