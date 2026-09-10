import type { MemberRole } from './types';

/**
 * Matrice des permissions par rôle (#39).
 *
 * Sans hiérarchie, un groupe de cinquante personnes devient ingouvernable et
 * vulnérable au spam. Ce modèle à trois rôles est aussi la fondation des
 * permissions granulaires des communautés (M12).
 *
 * ---
 *
 * **Cette matrice est la source.** Le serveur porte la même, sous forme de
 * lignes dans `public.role_permissions` (migration 20260910120015), parce que
 * PostgreSQL ne sait pas lire du TypeScript. Deux copies, donc — et deux copies
 * dérivent toujours, tôt ou tard.
 *
 * D'où `permissions.sql.test.ts`, qui lit le fichier de migration et compare
 * ligne à ligne. La divergence devient une erreur de test, pas un bug de
 * sécurité découvert en production.
 *
 * ---
 *
 * **Ce fichier ne constitue jamais la sécurité.** Il sert à l'interface : ne pas
 * proposer une action vouée à l'échec. La règle est appliquée par RLS et par les
 * triggers, côté serveur (#14), et un appel direct à l'API s'y heurte de la même
 * façon qu'un bouton.
 */

export type Permission =
  /** Écrire dans la conversation. Retiré aux membres en mode restreint. */
  | 'send_message'
  | 'add_member'
  | 'remove_member'
  /** Nom, photo, description. */
  | 'edit_group'
  /** Basculer le mode restreint. */
  | 'set_restricted'
  /** Promouvoir ou rétrograder. Jamais transférer la propriété. */
  | 'change_role'
  | 'transfer_ownership'
  | 'delete_group'
  /** Quitter le groupe. Le propriétaire doit d'abord transférer (#42). */
  | 'leave';

export const PERMISSIONS: readonly Permission[] = [
  'send_message',
  'add_member',
  'remove_member',
  'edit_group',
  'set_restricted',
  'change_role',
  'transfer_ownership',
  'delete_group',
  'leave',
];

export const ROLES: readonly MemberRole[] = ['owner', 'admin', 'member'];

/**
 * Qui peut quoi.
 *
 * Deux lignes méritent qu'on s'y arrête.
 *
 * `change_role` est réservé au PROPRIÉTAIRE, pas aux administrateurs. Un
 * administrateur qui peut en nommer d'autres peut aussi les rétrograder : à
 * trois administrateurs, le groupe se prend un jeu de chaises musicales et le
 * propriétaire n'a aucun recours.
 *
 * `leave` est refusé au propriétaire. C'est le cas limite que #39 demandait de
 * trancher explicitement : plutôt qu'une promotion automatique du plus ancien
 * administrateur — silencieuse, et qui confie un groupe à quelqu'un qui ne l'a
 * pas demandé — le départ est bloqué tant que la propriété n'a pas été
 * transférée. Un groupe ne se retrouve donc jamais sans propriétaire.
 */
const MATRIX: Readonly<Record<MemberRole, readonly Permission[]>> = {
  owner: [
    'send_message',
    'add_member',
    'remove_member',
    'edit_group',
    'set_restricted',
    'change_role',
    'transfer_ownership',
    'delete_group',
  ],
  admin: ['send_message', 'add_member', 'remove_member', 'edit_group', 'leave'],
  member: ['send_message', 'leave'],
};

export interface PermissionContext {
  readonly role: MemberRole;
  /** Mode restreint : seuls les administrateurs écrivent (#39). */
  readonly restricted?: boolean;
}

export function can(context: PermissionContext, permission: Permission): boolean {
  const granted = MATRIX[context.role].includes(permission);

  if (permission === 'send_message' && context.restricted === true) {
    // Le mode restreint ne retire pas la permission au rôle : il ajoute une
    // condition. La distinction compte pour l'interface, qui doit expliquer
    // « seuls les administrateurs peuvent écrire » plutôt que de désactiver le
    // composeur sans un mot.
    return context.role === 'owner' || context.role === 'admin';
  }

  return granted;
}

/** La matrice brute, pour les tests et pour la comparaison avec le serveur. */
export function permissionsOf(role: MemberRole): readonly Permission[] {
  return MATRIX[role];
}
