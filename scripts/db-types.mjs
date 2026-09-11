#!/usr/bin/env node
/**
 * Génère les types TypeScript depuis le schéma Postgres, et vérifie qu'ils
 * sont à jour.
 *
 * La vérification ne relance pas la génération : elle compare une empreinte des
 * fichiers de migration à celle inscrite en tête du fichier généré. La CI n'a
 * donc besoin ni de Docker, ni d'une base, ni du réseau — elle constate juste
 * qu'une migration n'a pas été ajoutée sans régénérer les types.
 *
 *   node scripts/db-types.mjs            génère
 *   node scripts/db-types.mjs --check    vérifie et sort en erreur si périmé
 */

import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const migrationsDir = join(root, 'supabase', 'migrations');
const typesFile = join(root, 'packages', 'core', 'src', 'database.types.ts');

const MARKER = '// migrations-hash:';

/** Empreinte du contenu de toutes les migrations, dans l'ordre. */
function hashMigrations() {
  const files = readdirSync(migrationsDir)
    .filter((name) => name.endsWith('.sql'))
    .sort();

  const hash = createHash('sha256');
  for (const name of files) {
    hash.update(name);
    // Les fins de ligne sont normalisées : le dépôt se développe sous Windows
    // et la CI tourne sous Linux, l'empreinte ne doit pas dépendre de ça.
    hash.update(readFileSync(join(migrationsDir, name), 'utf8').replace(/\r\n/g, '\n'));
  }
  return hash.digest('hex').slice(0, 16);
}

function readRecordedHash() {
  const content = readFileSync(typesFile, 'utf8');
  const line = content.split('\n').find((l) => l.startsWith(MARKER));
  return line ? line.slice(MARKER.length).trim() : null;
}

function generate() {
  // `shell: true` est indispensable sous Windows : depuis Node 20, spawnSync
  // refuse de lancer un `.cmd` directement (durcissement CVE-2024-27980) et
  // échoue sur un EINVAL peu parlant.
  const output = execFileSync(
    'pnpm',
    ['exec', 'supabase', 'gen', 'types', 'typescript', '--local'],
    {
      cwd: root,
      encoding: 'utf8',
      maxBuffer: 32 * 1024 * 1024,
      shell: process.platform === 'win32',
    },
  );

  const header = [
    '// Fichier généré par `pnpm db:types`. Ne pas modifier à la main.',
    `${MARKER} ${hashMigrations()}`,
    '',
  ].join('\n');

  writeFileSync(typesFile, header + output.replace(/\r\n/g, '\n'), 'utf8');
  console.log(`types générés — empreinte ${hashMigrations()}`);
}

function check() {
  const expected = hashMigrations();
  const recorded = readRecordedHash();

  if (recorded === expected) {
    console.log(`types à jour — empreinte ${expected}`);
    return;
  }

  console.error(
    [
      'Les types TypeScript ne correspondent plus aux migrations.',
      `  attendu  : ${expected}`,
      `  enregistré : ${recorded ?? '(absent)'}`,
      '',
      'Régénérer avec :  pnpm db:start && pnpm db:reset && pnpm db:types',
    ].join('\n'),
  );
  process.exit(1);
}

if (process.argv.includes('--check')) {
  check();
} else {
  generate();
}
