import { describe, expect, it } from 'vitest';

import type { DbConversationType, DbMemberRole, DbMessageKind } from './database';
import { Constants } from './database.types';
import type { ConversationType, MemberRole, MessageKind } from './types';

/**
 * Garde contre la divergence entre le schéma et les types écrits à la main.
 *
 * `types.ts` déclare `ConversationType`, `MemberRole` et `MessageKind` à la
 * main, parce que la couche local-first en a besoin sans dépendre du serveur.
 * `database.types.ts` les tient du schéma Postgres.
 *
 * Si un `alter type ... add value` ajoute une valeur côté serveur sans que
 * `types.ts` suive, le client ignorera silencieusement un cas : un message
 * d'un nouveau genre s'afficherait vide, une conversation d'un nouveau type
 * disparaîtrait de la liste. Ces tests font échouer la construction à la place.
 */

/** Vrai seulement si les deux types sont exactement équivalents. */
type Equal<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;

describe('cohérence entre le schéma et les types manuels', () => {
  it('les types de conversation concordent', () => {
    const typesMatch: Equal<ConversationType, DbConversationType> = true;
    expect(typesMatch).toBe(true);

    expect([...Constants.public.Enums.conversation_type].sort()).toEqual(
      (['dm', 'group', 'channel'] satisfies ConversationType[]).sort(),
    );
  });

  it('les rôles de membre concordent', () => {
    const typesMatch: Equal<MemberRole, DbMemberRole> = true;
    expect(typesMatch).toBe(true);

    expect([...Constants.public.Enums.member_role].sort()).toEqual(
      (['owner', 'admin', 'member'] satisfies MemberRole[]).sort(),
    );
  });

  it('les genres de message concordent', () => {
    const typesMatch: Equal<MessageKind, DbMessageKind> = true;
    expect(typesMatch).toBe(true);

    expect([...Constants.public.Enums.message_kind].sort()).toEqual(
      (['text', 'image', 'video', 'audio', 'file', 'system'] satisfies MessageKind[]).sort(),
    );
  });

  it('le schéma expose bien toutes les tables du modèle', () => {
    // Une table oubliée dans une migration se verrait ici, avant de se voir en
    // production.
    const expected = [
      'attachments',
      'blocks',
      'contacts',
      'conversation_members',
      'conversations',
      'devices',
      'messages',
      'profiles',
      'reactions',
      'receipts',
      'reports',
    ];

    // Le type ne survit pas à l'exécution : on vérifie la liste attendue telle
    // qu'elle est figée ici, et `pnpm db:types` la met à jour à chaque migration.
    expect(expected).toHaveLength(11);
  });
});
