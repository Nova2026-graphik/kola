import { createClient, type SupabaseClient } from '@supabase/supabase-js';

import type { Database } from '@kola/core';

import type { KeyValueStore } from './secure-storage';
import { createChunkedStorage } from './secure-storage';

/**
 * Client Supabase typé.
 *
 * Il n'est **jamais** importé depuis un écran : la règle est appliquée par
 * ESLint sur `apps/mobile/app/` (#2), et c'est ce qui garantit que l'interface
 * lit SQLite et non le réseau (ADR-0002). Seuls les repositories et la couche
 * d'authentification passent par ici.
 */

export type KolaClient = SupabaseClient<Database>;

export interface ClientOptions {
  readonly url: string;
  readonly anonKey: string;
  /**
   * Magasin de session. En production, `expo-secure-store` : un jeton de
   * rafraîchissement dans le stockage ordinaire est lisible par n'importe
   * quelle application sur un appareil compromis.
   */
  readonly storage: KeyValueStore;
}

let instance: KolaClient | null = null;

export function createKolaClient(options: ClientOptions): KolaClient {
  if (options.url === '' || options.anonKey === '') {
    throw new Error(
      'URL ou clé Supabase absente : renseigner EXPO_PUBLIC_SUPABASE_URL et EXPO_PUBLIC_SUPABASE_ANON_KEY dans .env',
    );
  }

  return createClient<Database>(options.url, options.anonKey, {
    auth: {
      // Le découpage contourne la limite de 2048 octets d'Android (#23).
      storage: createChunkedStorage(options.storage),
      autoRefreshToken: true,
      persistSession: true,
      // Aucun flux OAuth par redirection : l'authentification se fait par OTP,
      // et détecter une session dans une URL n'a pas de sens sur mobile.
      detectSessionInUrl: false,
    },
    global: {
      headers: { 'x-application-name': 'kola' },
    },
  });
}

export function setClient(client: KolaClient): void {
  instance = client;
}

export function getClient(): KolaClient {
  if (!instance) {
    throw new Error(
      'client Supabase non initialisé : appeler setClient() au démarrage, après createKolaClient()',
    );
  }
  return instance;
}

export function hasClient(): boolean {
  return instance !== null;
}

/** Oublie le client. Utilisé à la déconnexion et dans les tests. */
export function resetClient(): void {
  instance = null;
}
