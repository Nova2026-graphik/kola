import NetInfo, { type NetInfoState } from '@react-native-community/netinfo';

import type { ConnectionType } from '@kola/core';

import type { NativeNetworkSnapshot, NativeSubscription } from './monitor';

/**
 * Adaptateur entre `@react-native-community/netinfo` et la surveillance.
 *
 * Volontairement mince : c'est le seul fichier du dossier qui dépend d'un
 * module natif, donc le seul intestable sous Node. Toute la logique vit dans
 * `monitor.ts`, qui n'en sait rien.
 */

function toConnectionType(state: NetInfoState): ConnectionType {
  switch (state.type) {
    case 'wifi':
    case 'ethernet':
      return 'wifi';
    case 'cellular':
      return 'cellular';
    case 'none':
      return 'none';
    default:
      return 'other';
  }
}

function toSnapshot(state: NetInfoState): NativeNetworkSnapshot {
  const details = state.details as { isConnectionExpensive?: boolean } | null;

  return {
    // `isInternetReachable` reste à `null` tant que NetInfo n'a pas conclu :
    // on ne le lit pas ici. La joignabilité réelle est du ressort de la sonde,
    // qui interroge NOTRE serveur plutôt qu'un point d'entrée tiers.
    isConnected: state.isConnected ?? false,
    connectionType: toConnectionType(state),
    isMetered: details?.isConnectionExpensive ?? false,
  };
}

export const subscribeNetInfo: NativeSubscription = (listener) => {
  const unsubscribe = NetInfo.addEventListener((state) => {
    listener(toSnapshot(state));
  });

  // NetInfo n'émet qu'au changement : sans lecture initiale, l'application
  // resterait dans l'état indéterminé jusqu'à la première variation.
  void NetInfo.fetch().then((state) => {
    listener(toSnapshot(state));
  });

  return unsubscribe;
};
