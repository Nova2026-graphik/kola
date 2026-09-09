import { Link } from 'expo-router';
import { StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { MIN_TOUCH_TARGET } from '@kola/ui';

/**
 * Liste des conversations — écran d'accueil de l'application.
 *
 * Contenu provisoire : la liste réelle, lue depuis SQLite, arrive en #29.
 * Cet écran sert pour l'instant à vérifier que le routage et la résolution
 * des paquets du workspace fonctionnent de bout en bout.
 */
export default function ConversationsScreen() {
  const insets = useSafeAreaInsets();

  return (
    <View style={[styles.container, { paddingTop: insets.top + 24 }]}>
      <Text style={styles.title}>Kola</Text>
      <Text style={styles.subtitle}>
        Vos conversations s&apos;afficheront ici, réseau ou pas. Elles sont lues depuis la base
        locale.
      </Text>

      <Link href="/connexion" style={styles.link}>
        Aller à la connexion
      </Link>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    paddingHorizontal: 24,
    gap: 12,
    backgroundColor: '#FFFFFF',
  },
  title: {
    fontSize: 32,
    fontWeight: '700',
    color: '#A8402C',
  },
  subtitle: {
    fontSize: 15,
    lineHeight: 22,
    color: '#4A4A4A',
  },
  link: {
    marginTop: 8,
    minHeight: MIN_TOUCH_TARGET,
    lineHeight: MIN_TOUCH_TARGET,
    fontSize: 16,
    color: '#A8402C',
    textDecorationLine: 'underline',
  },
});
