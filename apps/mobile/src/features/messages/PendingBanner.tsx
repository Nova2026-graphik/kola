import { StyleSheet, Text, View } from 'react-native';

import { pendingSummary } from '@kola/core';

/**
 * Récapitulatif des messages qui n'ont pas encore quitté l'appareil (#32).
 *
 * Il ne s'affiche que lorsqu'il a quelque chose à dire : un bandeau permanent
 * devient invisible, et le silence est en soi une information — tout est parti.
 *
 * Le ton distingue les deux cas. Une attente est un état normal du produit et
 * se règle toute seule au retour du réseau. Un échec demande une action, et
 * mérite donc d'être signalé plus fermement.
 */

interface Props {
  readonly pendingCount: number;
  readonly failedCount: number;
}

export function PendingBanner({ pendingCount, failedCount }: Props): React.JSX.Element | null {
  const message = pendingSummary(pendingCount, failedCount);

  if (message === null) {
    return null;
  }

  const isFailure = failedCount > 0;

  return (
    <View
      style={[styles.container, isFailure ? styles.failure : styles.waiting]}
      accessibilityRole="alert"
      accessibilityLiveRegion="polite"
    >
      <Text style={styles.text}>
        {message}
        {isFailure ? ' — touchez un message pour réessayer' : ''}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    paddingHorizontal: 16,
    paddingVertical: 6,
  },
  waiting: {
    backgroundColor: '#3F3B38',
  },
  failure: {
    backgroundColor: '#7A2E22',
  },
  text: {
    fontSize: 12,
    textAlign: 'center',
    color: '#F5EFE6',
  },
});
