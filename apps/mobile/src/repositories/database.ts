import type { BaseSQLiteDatabase } from 'drizzle-orm/sqlite-core';

import type * as schema from '../db/schema';

/**
 * Type de base accepté par les repositories.
 *
 * Volontairement générique sur le type de résultat du pilote : l'application
 * branche `expo-sqlite`, les tests branchent `better-sqlite3`, et le code des
 * repositories est rigoureusement le même dans les deux cas. Sans cela, tester
 * un repository imposerait de démarrer React Native (#71).
 *
 * Le mode est `'sync'` : SQLite est local, il n'y a rien à attendre, et les
 * transactions synchrones sont les seules qui garantissent l'atomicité de
 * « écriture métier + mise en file » sur les deux pilotes.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type LocalDatabase = BaseSQLiteDatabase<'sync', any, typeof schema>;

export type Transaction = Parameters<Parameters<LocalDatabase['transaction']>[0]>[0];

/** Horloge injectable : les tests ne doivent pas dépendre de l'heure réelle. */
export type Clock = () => number;

/** Générateur d'identifiant injectable, pour des tests déterministes. */
export type IdGenerator = () => string;

export interface RepositoryOptions {
  readonly db: LocalDatabase;
  readonly now?: Clock;
  readonly newId?: IdGenerator;
}
