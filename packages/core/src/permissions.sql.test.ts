import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { permissionsOf, ROLES, type Permission } from './permissions';
import type { MemberRole } from './types';

/**
 * Concordance entre la matrice du client et celle du serveur (#39).
 *
 * La matrice existe nécessairement en deux exemplaires : l'interface doit
 * savoir quoi proposer, et PostgreSQL ne lit pas le TypeScript. Deux copies
 * dérivent toujours — et la dérive, ici, est un trou de sécurité qu'on
 * découvrirait en production.
 *
 * Ce test lit la migration et compare. Il fait de la dérive une erreur de test,
 * ce qui est le seul endroit où elle coûte peu.
 */

const MIGRATION = join(
  import.meta.dirname,
  '../../../supabase/migrations/20260910120015_roles_and_group_settings.sql',
);

const START = 'MATRICE DES PERMISSIONS — DÉBUT';
const END = 'MATRICE DES PERMISSIONS — FIN';

function readServerMatrix(): Map<MemberRole, Set<Permission>> {
  const sql = readFileSync(MIGRATION, 'utf8');
  const start = sql.indexOf(START);
  const end = sql.indexOf(END);
  if (start === -1 || end === -1) {
    throw new Error(
      'marqueurs de matrice introuvables dans la migration : ils délimitent le bloc à comparer, ' +
        'les retirer désarmerait ce test en silence',
    );
  }

  const block = sql.slice(start, end);
  const matrix = new Map<MemberRole, Set<Permission>>();

  for (const [, role, permission] of block.matchAll(/\('(\w+)'\s*,\s*'(\w+)'\)/g)) {
    const key = role as MemberRole;
    const set = matrix.get(key) ?? new Set<Permission>();
    set.add(permission as Permission);
    matrix.set(key, set);
  }
  return matrix;
}

describe('matrice des permissions', () => {
  const server = readServerMatrix();

  it('extrait bien quelque chose de la migration', () => {
    // Sans ce contrôle, une expression régulière qui ne correspond plus ferait
    // passer tous les tests suivants sur des ensembles vides.
    expect(server.size).toBe(ROLES.length);
  });

  for (const role of ROLES) {
    it(`accorde à « ${role} » exactement les mêmes permissions des deux côtés`, () => {
      const client = [...permissionsOf(role)].sort();
      const fromServer = [...(server.get(role) ?? [])].sort();
      expect(fromServer).toEqual(client);
    });
  }

  it('n’accorde à personne une permission inconnue du client', () => {
    const known = new Set(ROLES.flatMap((role) => [...permissionsOf(role)]));
    for (const [role, permissions] of server) {
      for (const permission of permissions) {
        expect(known, `${role} → ${permission}`).toContain(permission);
      }
    }
  });
});
