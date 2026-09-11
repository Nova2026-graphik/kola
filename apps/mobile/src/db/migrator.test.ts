import BetterSqlite3 from 'better-sqlite3';
import { describe, expect, it } from 'vitest';

import { LOCAL_MIGRATIONS, TARGET_SCHEMA_VERSION } from './migrations';
import { getSchemaVersion, migrate, type RawDatabase } from './migrator';
import { createTestDatabase } from './testing';

function rawDatabase(): { db: RawDatabase; close: () => void } {
  const raw = new BetterSqlite3(':memory:');
  return {
    db: {
      execSync: (source) => {
        raw.exec(source);
      },
      getFirstSync: <T>(source: string) => (raw.prepare(source).get() as T | undefined) ?? null,
    },
    close: () => raw.close(),
  };
}

describe('migrations locales', () => {
  it('crée la base au premier lancement', () => {
    const { db, close } = rawDatabase();
    try {
      expect(getSchemaVersion(db)).toBe(0);

      const result = migrate(db);

      expect(result.from).toBe(0);
      expect(result.to).toBe(TARGET_SCHEMA_VERSION);
      expect(result.applied).toHaveLength(LOCAL_MIGRATIONS.length);
    } finally {
      close();
    }
  });

  it('ne rejoue rien au lancement suivant', () => {
    const { db, close } = rawDatabase();
    try {
      migrate(db);
      const second = migrate(db);

      expect(second.applied).toEqual([]);
      expect(second.from).toBe(TARGET_SCHEMA_VERSION);
      expect(second.to).toBe(TARGET_SCHEMA_VERSION);
    } finally {
      close();
    }
  });

  it("n'exécute que les migrations manquantes", () => {
    const { db, close } = rawDatabase();
    try {
      migrate(db);

      const added = migrate(db, [
        ...LOCAL_MIGRATIONS,
        {
          version: TARGET_SCHEMA_VERSION + 1,
          name: 'colonne supplémentaire',
          statements: ['alter table drafts add column pinned integer not null default 0'],
        },
      ]);

      expect(added.applied).toEqual(['colonne supplémentaire']);
      expect(added.to).toBe(TARGET_SCHEMA_VERSION + 1);
    } finally {
      close();
    }
  });

  it('ne corrompt pas la base quand une migration échoue en cours de route', () => {
    const { db, close } = rawDatabase();
    try {
      migrate(db);

      expect(() =>
        migrate(db, [
          ...LOCAL_MIGRATIONS,
          {
            version: TARGET_SCHEMA_VERSION + 1,
            name: 'migration fautive',
            statements: [
              'alter table drafts add column ok integer not null default 0',
              'ceci est du SQL invalide',
            ],
          },
        ]),
      ).toThrowError(/migration fautive/);

      // La transaction a été annulée : ni la version ni la colonne n'ont bougé.
      expect(getSchemaVersion(db)).toBe(TARGET_SCHEMA_VERSION);

      const columns = db.getFirstSync<{ count: number }>(
        "select count(*) as count from pragma_table_info('drafts') where name = 'ok'",
      );
      expect(columns?.count).toBe(0);
    } finally {
      close();
    }
  });

  it('applique les pragmas de performance', () => {
    const { raw, close } = createTestDatabase();
    try {
      expect(raw.pragma('foreign_keys', { simple: true })).toBe(1);
      expect(raw.pragma('busy_timeout', { simple: true })).toBe(5000);
      expect(raw.pragma('synchronous', { simple: true })).toBe(1); // NORMAL
    } finally {
      close();
    }
  });

  it('crée toutes les tables attendues', () => {
    const { raw, close } = createTestDatabase();
    try {
      const tables = raw
        .prepare("select name from sqlite_master where type = 'table' order by name")
        .all()
        .map((row) => (row as { name: string }).name)
        .filter((name) => !name.startsWith('sqlite_'));

      expect(tables).toEqual([
        'attachments',
        'conversation_members',
        'conversations',
        'drafts',
        'messages',
        'outbox',
        'profiles',
        'reactions',
        'receipts',
        'sync_state',
      ]);
    } finally {
      close();
    }
  });

  it('crée les index critiques du chemin de lecture', () => {
    const { raw, close } = createTestDatabase();
    try {
      const indexes = raw
        .prepare("select name from sqlite_master where type = 'index'")
        .all()
        .map((row) => (row as { name: string }).name);

      expect(indexes).toContain('messages_conversation_seq_idx');
      expect(indexes).toContain('conversations_last_message_at_idx');
      expect(indexes).toContain('outbox_operation_entity_idx');
      expect(indexes).toContain('outbox_next_attempt_idx');
    } finally {
      close();
    }
  });
});
