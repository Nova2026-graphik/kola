import { LOCAL_MIGRATIONS, TARGET_SCHEMA_VERSION, type LocalMigration } from './migrations';

/**
 * Surface minimale d'une base SQLite, réduite à ce dont le migrateur a besoin.
 *
 * Cette interface existe pour une raison précise : sans elle, le migrateur
 * importerait `expo-sqlite`, donc React Native, et deviendrait intestable sous
 * Node. Les tests branchent `better-sqlite3` derrière la même interface (#71).
 */
export interface RawDatabase {
  /** Exécute une ou plusieurs instructions sans résultat. */
  execSync: (source: string) => void;
  /** Exécute une requête et retourne la première ligne, ou null. */
  getFirstSync: <T>(source: string) => T | null;
}

/** Pragmas appliqués à chaque ouverture. */
export const PRAGMAS = [
  // Sans WAL, une écriture bloque les lectures : l'interface se fige pendant la
  // synchronisation, exactement au moment où elle doit rester utilisable.
  'journal_mode = WAL',
  // NORMAL suffit avec WAL : les données validées survivent au crash de
  // l'application. Seule une coupure d'alimentation peut perdre la dernière
  // transaction, ce qui est un compromis acceptable pour une messagerie et
  // évite un fsync par écriture sur un stockage lent.
  'synchronous = NORMAL',
  'foreign_keys = ON',
  // Plutôt que d'échouer immédiatement sur « database is locked » quand la
  // synchronisation écrit pendant que l'interface lit.
  'busy_timeout = 5000',
  // Les tables temporaires en mémoire : plus rapide, et rien à nettoyer.
  'temp_store = MEMORY',
] as const;

export function applyPragmas(db: RawDatabase): void {
  for (const pragma of PRAGMAS) {
    db.execSync(`pragma ${pragma};`);
  }
}

export function getSchemaVersion(db: RawDatabase): number {
  const row = db.getFirstSync<{ user_version: number }>('pragma user_version;');
  return row?.user_version ?? 0;
}

export interface MigrationResult {
  readonly from: number;
  readonly to: number;
  readonly applied: readonly string[];
}

/**
 * Applique les migrations manquantes, dans l'ordre.
 *
 * Chaque migration est enveloppée dans une transaction avec l'avancement de
 * `user_version`. Une interruption annule tout : la migration sera rejouée au
 * prochain démarrage plutôt que de laisser la base à moitié migrée.
 */
export function migrate(
  db: RawDatabase,
  migrations: readonly LocalMigration[] = LOCAL_MIGRATIONS,
): MigrationResult {
  const from = getSchemaVersion(db);
  const applied: string[] = [];

  const pending = [...migrations]
    .filter((migration) => migration.version > from)
    .sort((a, b) => a.version - b.version);

  for (const migration of pending) {
    db.execSync('begin;');
    try {
      for (const statement of migration.statements) {
        db.execSync(statement);
      }
      // `user_version` n'accepte pas de paramètre lié : la valeur vient de nos
      // propres migrations, jamais d'une entrée utilisateur.
      db.execSync(`pragma user_version = ${migration.version};`);
      db.execSync('commit;');
      applied.push(migration.name);
    } catch (error) {
      db.execSync('rollback;');
      throw new Error(
        `migration locale « ${migration.name} » (version ${migration.version}) échouée : ${
          error instanceof Error ? error.message : String(error)
        }`,
        { cause: error },
      );
    }
  }

  return { from, to: getSchemaVersion(db), applied };
}

/** Ouvre, configure et migre la base. Point d'entrée unique. */
export function prepareDatabase(db: RawDatabase): MigrationResult {
  applyPragmas(db);
  const result = migrate(db);

  if (result.to !== TARGET_SCHEMA_VERSION) {
    throw new Error(`base locale en version ${result.to}, ${TARGET_SCHEMA_VERSION} attendue`);
  }

  return result;
}
