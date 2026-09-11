import { describe, expect, it, vi } from 'vitest';

import { EMPTY_RUN_REPORT, type OutboxRunReport } from '@kola/core';

import type { OutboxProcessor } from './outbox-processor';
import { createOutboxScheduler, DEFAULT_POLL_INTERVAL_MS } from './scheduler';

/**
 * Les minuteurs sont simulés : un test qui attend réellement trente secondes
 * est un test que personne ne lancera.
 */

function countingProcessor(): { processor: OutboxProcessor; runs: () => number } {
  let runs = 0;
  return {
    processor: {
      runOnce: () => {
        runs += 1;
        return Promise.resolve(EMPTY_RUN_REPORT);
      },
      isRunning: () => false,
    },
    runs: () => runs,
  };
}

describe('ordonnanceur de la file', () => {
  it('déclenche une passe dès le démarrage', async () => {
    vi.useFakeTimers();
    try {
      const { processor, runs } = countingProcessor();
      const scheduler = createOutboxScheduler({ processor });

      scheduler.start();
      // L'application a pu être tuée avec des messages en attente : on ne peut
      // pas attendre le premier tic du minuteur.
      await vi.advanceTimersByTimeAsync(0);
      expect(runs()).toBe(1);

      scheduler.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('repasse périodiquement', async () => {
    vi.useFakeTimers();
    try {
      const { processor, runs } = countingProcessor();
      const scheduler = createOutboxScheduler({ processor });

      scheduler.start();
      await vi.advanceTimersByTimeAsync(0);
      expect(runs()).toBe(1);

      await vi.advanceTimersByTimeAsync(DEFAULT_POLL_INTERVAL_MS);
      expect(runs()).toBe(2);

      await vi.advanceTimersByTimeAsync(DEFAULT_POLL_INTERVAL_MS * 2);
      expect(runs()).toBe(4);

      scheduler.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('cesse toute passe après l’arrêt', async () => {
    vi.useFakeTimers();
    try {
      const { processor, runs } = countingProcessor();
      const scheduler = createOutboxScheduler({ processor });

      scheduler.start();
      await vi.advanceTimersByTimeAsync(0);
      scheduler.stop();

      // En arrière-plan, une boucle qui continue consomme des données et de la
      // batterie pour rien.
      await vi.advanceTimersByTimeAsync(DEFAULT_POLL_INTERVAL_MS * 5);
      expect(runs()).toBe(1);
      expect(scheduler.isStarted()).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('ne démarre pas deux minuteurs', async () => {
    vi.useFakeTimers();
    try {
      const { processor, runs } = countingProcessor();
      const scheduler = createOutboxScheduler({ processor });

      scheduler.start();
      scheduler.start();
      await vi.advanceTimersByTimeAsync(0);
      // Un seul démarrage effectif, donc une seule passe immédiate.
      expect(runs()).toBe(1);

      await vi.advanceTimersByTimeAsync(DEFAULT_POLL_INTERVAL_MS);
      expect(runs()).toBe(2);

      scheduler.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('déclenche une passe au retour du réseau', async () => {
    const { processor, runs } = countingProcessor();
    const scheduler = createOutboxScheduler({ processor });

    // C'est le déclencheur qui compte vraiment : celui qui fait partir les
    // messages écrits pendant la coupure (#55).
    await scheduler.trigger();
    expect(runs()).toBe(1);
  });

  it('survit à une passe qui échoue', async () => {
    let calls = 0;
    const errors: unknown[] = [];

    const processor: OutboxProcessor = {
      runOnce: (): Promise<OutboxRunReport> => {
        calls += 1;
        if (calls === 1) {
          return Promise.reject(new Error('base verrouillée'));
        }
        return Promise.resolve(EMPTY_RUN_REPORT);
      },
      isRunning: () => false,
    };

    const scheduler = createOutboxScheduler({
      processor,
      onError: (error) => errors.push(error),
    });

    const first = await scheduler.trigger();
    expect(first).toBeNull();
    expect(errors).toHaveLength(1);

    // Un incident isolé ne doit pas condamner tous les messages en attente.
    const second = await scheduler.trigger();
    expect(second).toEqual(EMPTY_RUN_REPORT);
  });

  it('reste arrêtable même si aucune passe n’a eu lieu', () => {
    const { processor } = countingProcessor();
    const scheduler = createOutboxScheduler({ processor });

    expect(() => scheduler.stop()).not.toThrow();
    expect(scheduler.isStarted()).toBe(false);
  });
});
