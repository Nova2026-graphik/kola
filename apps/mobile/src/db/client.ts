import { drizzle, type ExpoSQLiteDatabase } from 'drizzle-orm/expo-sqlite';
import * as SQLite from 'expo-sqlite';

import { prepareDatabase, type RawDatabase } from './migrator';
import * as schema from './schema';

/**
 * Ouverture de la base locale — source de vérité de l'application (ADR-0002).
 *
 * Ce fichier est le seul du dossier `db/` à importer `expo-sqlite` : tout le
 * reste (schéma, migrations, migrateur) reste exécutable sous Node pour que les
 * tests puissent tourner sans React Native.
 */

export const DATABASE_NAME = 'kola.db';

export type Database = ExpoSQLiteDatabase<typeof schema>;

let instance: Database | null = null;

/**
 * Ouvre la base, applique les pragmas et joue les migrations manquantes.
 *
 * Appelée une seule fois au démarrage, avant le premier rendu : la liste des
 * conversations doit s'afficher depuis le local, réseau ou pas.
 */
export function openDatabase(): Database {
  if (instance) {
    return instance;
  }

  const raw = SQLite.openDatabaseSync(DATABASE_NAME);
  prepareDatabase(raw as unknown as RawDatabase);

  instance = drizzle(raw, { schema });
  return instance;
}

export function getDatabase(): Database {
  if (!instance) {
    throw new Error(
      "la base locale n'est pas ouverte : appeler openDatabase() au démarrage, avant tout accès",
    );
  }
  return instance;
}

/**
 * Ferme la base et oublie l'instance.
 *
 * Utilisée à la déconnexion, qui doit purger les données locales (#23).
 */
export function closeDatabase(): void {
  instance = null;
}

export { schema };
