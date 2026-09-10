import { StyleSheet, Text, View } from 'react-native';

import type { BannerKind } from '@kola/core';

import { useBanner } from '../network/store';

/**
 * Bandeau d'état réseau.
 *
 * Le ton compte autant que la fonction. Être hors ligne n'est pas une panne :
 * c'est un état normal du produit, et l'application reste pleinement utilisable
 * (ADR-0002). Le bandeau informe, il n'alarme pas — pas de rouge, pas de
 * message d'erreur, et surtout aucun contrôle désactivé.
 *
 * Il ne masque rien : il pousse le contenu vers le bas plutôt que de le
 * recouvrir.
 */

interface BannerStyle {
  readonly label: string;
  readonly background: string;
  readonly color: string;
}

const BANNERS: Record<Exclude<BannerKind, 'none'>, BannerStyle> = {
  offline: {
    // Pas « Erreur réseau » : ce qui compte pour l'utilisateur, c'est que ses
    // messages ne sont pas perdus.
    label: 'Hors ligne. Vos messages partiront au retour du réseau.',
    background: '#3F3B38',
    color: '#F5EFE6',
  },
  limited: {
    // Le cas du portail captif : le Wi-Fi marche, mais rien ne passe. Le dire
    // évite de chercher un problème du côté de l'application.
    label: 'Connecté, mais sans accès au service.',
    background: '#7A5A2E',
    color: '#F5EFE6',
  },
  reconnecting: {
    label: 'Reconnexion…',
    background: '#3F3B38',
    color: '#F5EFE6',
  },
  syncing: {
    label: 'Envoi en cours…',
    background: '#2F5D4A',
    color: '#F5EFE6',
  },
};

export function OfflineBanner(): React.JSX.Element | null {
  const kind = useBanner();

  if (kind === 'none') {
    return null;
  }

  const banner = BANNERS[kind];

  return (
    <View
      style={[styles.container, { backgroundColor: banner.background }]}
      accessibilityRole="alert"
      accessibilityLiveRegion="polite"
    >
      <Text style={[styles.label, { color: banner.color }]} numberOfLines={2}>
        {banner.label}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    paddingVertical: 8,
    paddingHorizontal: 16,
    width: '100%',
  },
  label: {
    fontSize: 13,
    lineHeight: 18,
    textAlign: 'center',
  },
});
