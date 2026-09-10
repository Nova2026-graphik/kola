import Constants from 'expo-constants';
import * as SecureStore from 'expo-secure-store';
import { create } from 'zustand';

import { createKolaClient, getSession, onAuthChange, setClient, signOut } from '@kola/api';

/**
 * Session de l'utilisateur (#23).
 *
 * Demander à se reconnecter à chaque ouverture serait rédhibitoire, surtout
 * quand le réseau ne permet pas toujours de recevoir un SMS. La session
 * survit donc au redémarrage, dans un stockage chiffré par le système.
 *
 * Point critique pour le local-first : **une session expirée ne bloque jamais
 * la lecture de l'historique déjà synchronisé** (ADR-0002). L'utilisateur
 * revient à l'écran de connexion, mais ses données locales restent intactes.
 */

export type SessionStatus = 'loading' | 'authenticated' | 'anonymous';

interface SessionStore {
  readonly status: SessionStatus;
  readonly userId: string | null;
  readonly setSession: (userId: string | null) => void;
  readonly setLoading: () => void;
}

export const useSessionStore = create<SessionStore>((set) => ({
  status: 'loading',
  userId: null,
  setSession: (userId: string | null) =>
    set({ status: userId === null ? 'anonymous' : 'authenticated', userId }),
  setLoading: () => set({ status: 'loading', userId: null }),
}));

/**
 * Adaptateur `expo-secure-store`.
 *
 * Le découpage sous la limite de 2048 octets d'Android est assuré en amont par
 * `createChunkedStorage`, dans `@kola/api`.
 */
const secureStore = {
  getItem: (key: string) => SecureStore.getItemAsync(key),
  setItem: (key: string, value: string) => SecureStore.setItemAsync(key, value),
  removeItem: (key: string) => SecureStore.deleteItemAsync(key),
};

interface SupabaseConfig {
  readonly url: string;
  readonly anonKey: string;
}

/** Lit la configuration injectée par `app.config.ts`. */
export function readSupabaseConfig(): SupabaseConfig | null {
  const extra = Constants.expoConfig?.extra as
    { supabaseUrl?: string | null; supabaseAnonKey?: string | null } | undefined;

  const url = extra?.supabaseUrl ?? null;
  const anonKey = extra?.supabaseAnonKey ?? null;

  if (url === null || anonKey === null || url === '' || anonKey === '') {
    return null;
  }
  return { url, anonKey };
}

let unsubscribe: (() => void) | null = null;

/**
 * Prépare le client et restaure la session.
 *
 * Appelée au démarrage, **après** l'ouverture de la base locale : l'ordre
 * compte, puisque l'application doit rester utilisable même si cette étape
 * échoue.
 */
export async function initSession(): Promise<void> {
  const config = readSupabaseConfig();

  if (config === null) {
    // Sans configuration, l'application reste utilisable en lecture locale.
    // C'est le cas pendant le développement, avant que le projet Supabase ne
    // soit câblé (#7) — mieux vaut un état « anonyme » explicite qu'un
    // plantage au démarrage.
    useSessionStore.getState().setSession(null);
    return;
  }

  setClient(createKolaClient({ ...config, storage: secureStore }));

  const session = await getSession();
  useSessionStore.getState().setSession(session?.user.id ?? null);

  unsubscribe?.();
  // Suit les renouvellements de jeton et l'expiration du jeton de
  // rafraîchissement, qui ramène à l'authentification sans effacer le local.
  unsubscribe = onAuthChange((next) => {
    useSessionStore.getState().setSession(next?.user.id ?? null);
  });
}

export async function endSession(): Promise<void> {
  await signOut();
  useSessionStore.getState().setSession(null);
}

/** Identifiant de l'utilisateur courant, ou `null`. */
export function useCurrentUserId(): string | null {
  return useSessionStore((state) => state.userId);
}

export function useSessionStatus(): SessionStatus {
  return useSessionStore((state) => state.status);
}
