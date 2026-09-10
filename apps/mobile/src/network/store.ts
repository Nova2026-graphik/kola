import { useSyncExternalStore } from 'react';
import { create } from 'zustand';

import { INITIAL_NETWORK_STATE, bannerFor, type BannerKind, type NetworkState } from '@kola/core';

import type { NetworkMonitor } from './monitor';

/**
 * État réseau exposé à l'interface.
 *
 * Zustand pour l'état d'interface, conformément à la stack. La surveillance
 * (`monitor.ts`) reste la source : le store n'est qu'un pont vers React, ce qui
 * permet de tester toute la logique sans monter le moindre composant.
 */

interface NetworkStore extends NetworkState {
  readonly setState: (state: NetworkState) => void;
}

export const useNetworkStore = create<NetworkStore>((set) => ({
  ...INITIAL_NETWORK_STATE,
  setState: (state: NetworkState) => set(state),
}));

/** Branche une surveillance sur le store. Retourne de quoi se débrancher. */
export function connectMonitorToStore(monitor: NetworkMonitor): () => void {
  useNetworkStore.getState().setState(monitor.getState());
  return monitor.subscribe((state) => {
    useNetworkStore.getState().setState(state);
  });
}

/** Le bandeau à afficher, ou `none`. */
export function useBanner(): BannerKind {
  return useSyncExternalStore(
    useNetworkStore.subscribe,
    () => bannerFor(useNetworkStore.getState()),
    () => bannerFor(INITIAL_NETWORK_STATE),
  );
}

export function useIsMetered(): boolean {
  return useNetworkStore((state) => state.isMetered);
}
