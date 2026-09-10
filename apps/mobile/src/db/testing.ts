import BetterSqlite3 from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';

import { prepareDatabase, type RawDatabase } from './migrator';
import * as schema from './schema';

/**
 * Base de test en mémoire.
 *
 * C'est le pendant Node de `client.ts` : le même schéma, les mêmes migrations,
 * les mêmes pragmas, derrière un pilote qui ne demande pas React Native. Sans
 * cela, les repositories seraient intestables — et ce sont précisément les
 * composants dont les bugs ne se voient qu'après une coupure réseau chez un
 * utilisateur, sans trace exploitable (ADR-0002).
 *
 * Ce fichier n'est jamais embarqué dans l'application : rien de `src/` hors des
 * tests ne l'importe.
 */

/** Adapte l'API de better-sqlite3 à la surface attendue par le migrateur. */
function adapt(raw: BetterSqlite3.Database): RawDatabase {
  return {
    execSync: (source: string) => {
      raw.exec(source);
    },
    getFirstSync: <T>(source: string) => (raw.prepare(source).get() as T | undefined) ?? null,
  };
}

export interface TestDatabase {
  readonly db: ReturnType<typeof drizzle<typeof schema>>;
  readonly raw: BetterSqlite3.Database;
  readonly close: () => void;
}

export function createTestDatabase(): TestDatabase {
  const raw = new BetterSqlite3(':memory:');

  // WAL n'a pas de sens sur une base en mémoire, et better-sqlite3 refuse le
  // pragma. Le reste de la préparation est identique à la production.
  const adapted = adapt(raw);
  prepareDatabase({
    execSync: (source: string) => {
      if (source.includes('journal_mode = WAL')) {
        return;
      }
      adapted.execSync(source);
    },
    getFirstSync: adapted.getFirstSync,
  });

  return {
    db: drizzle(raw, { schema }),
    raw,
    close: () => raw.close(),
  };
}

/** Horloge déterministe : les tests ne doivent jamais dépendre de l'heure réelle. */
export function createClock(start = 1_767_225_600_000): {
  now: () => number;
  advance: (ms: number) => void;
} {
  let current = start;
  return {
    now: () => current,
    advance: (ms: number) => {
      current += ms;
    },
  };
}

/** Générateur d'identifiants déterministe. */
export function createIdGenerator(prefix = 'id'): () => string {
  let counter = 0;
  return () => {
    counter += 1;
    return `${prefix}-${String(counter).padStart(4, '0')}`;
  };
}
