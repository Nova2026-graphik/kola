import * as Crypto from 'expo-crypto';

import type { ConversationRepository, MessageRepository } from '@kola/core';

import { getDatabase } from '../db/client';

import { createConversationRepository } from './conversations';
import type { LocalDatabase } from './database';
import { createMessageRepository } from './messages';

/**
 * Point d'accès unique aux repositories.
 *
 * Les écrans passent par ici, jamais par le client Supabase — la règle est
 * appliquée par ESLint sur `apps/mobile/app/` depuis #2, et c'est ce qui
 * matérialise le local-first (ADR-0002).
 */

export interface Repositories {
  readonly messages: MessageRepository;
  readonly conversations: ConversationRepository;
}

let instance: Repositories | null = null;

/** `expo-crypto` fournit `randomUUID`, absent du runtime React Native. */
function newId(): string {
  return Crypto.randomUUID();
}

export function createRepositories(db: LocalDatabase): Repositories {
  return {
    messages: createMessageRepository({ db, newId }),
    conversations: createConversationRepository({ db }),
  };
}

/** Initialise les repositories sur la base ouverte. Appelé au démarrage. */
export function initRepositories(): Repositories {
  instance ??= createRepositories(getDatabase() as unknown as LocalDatabase);
  return instance;
}

export function getRepositories(): Repositories {
  if (!instance) {
    throw new Error(
      'repositories non initialisés : appeler initRepositories() au démarrage, après openDatabase()',
    );
  }
  return instance;
}

/** Remet à zéro. Utilisé à la déconnexion, qui purge les données locales (#23). */
export function resetRepositories(): void {
  instance = null;
}

export { createConversationRepository } from './conversations';
export { createMessageRepository, countUnsent } from './messages';
export type { LocalDatabase, RepositoryOptions } from './database';
export * as outbox from './outbox';
