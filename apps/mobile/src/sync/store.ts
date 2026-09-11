import { create } from 'zustand';

import type { SyncEngineState } from './engine';

/**
 * État de la synchronisation, exposé à l'interface.
 *
 * Même partage des rôles que pour l'état réseau : le moteur reste la source, ce
 * store n'est qu'un pont vers React. Le moteur se teste ainsi sans monter le
 * moindre composant — et c'est lui qui porte la logique difficile.
 *
 * L'indicateur doit rester DISCRET (#53) : la synchronisation ne bloque jamais
 * l'interface, qui lit la base locale et n'a besoin de rien attendre.
 */

const IDLE: SyncEngineState = { phase: 'idle', conversationId: null, remaining: 0 };

interface SyncStore extends SyncEngineState {
  readonly setState: (state: SyncEngineState) => void;
}

export const useSyncStore = create<SyncStore>((set) => ({
  ...IDLE,
  setState: (state: SyncEngineState) => set(state),
}));

export function publishSyncState(state: SyncEngineState): void {
  useSyncStore.getState().setState(state);
}

/** Vrai pendant qu'une passe est en cours. Rien de plus : c'est un indicateur. */
export function useIsSyncing(): boolean {
  return useSyncStore((state) => state.phase !== 'idle');
}

/** Conversations restant à rattraper, pour une éventuelle jauge. */
export function useSyncRemaining(): number {
  return useSyncStore((state) => state.remaining);
}
