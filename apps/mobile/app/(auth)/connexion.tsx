import { Link } from 'expo-router';
import { StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { DEFAULT_COUNTRY_CALLING_CODE } from '@kola/core';

/**
 * Écran de connexion — contenu provisoire.
 *
 * Le parcours réel (saisie du numéro, OTP SMS, indicatif +228 par défaut)
 * arrive en #19 et #21.
 */
export default function ConnexionScreen() {
  const insets = useSafeAreaInsets();

  return (
    <View style={[styles.container, { paddingTop: insets.top + 24 }]}>
      <Text style={styles.title}>Connexion</Text>
      <Text style={styles.subtitle}>
        Indicatif par défaut : {DEFAULT_COUNTRY_CALLING_CODE} (Togo)
      </Text>

      <Link href="/" style={styles.link}>
        Retour aux conversations
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
    fontSize: 28,
    fontWeight: '700',
    color: '#1A1A1A',
  },
  subtitle: {
    fontSize: 15,
    color: '#4A4A4A',
  },
  link: {
    marginTop: 8,
    fontSize: 16,
    color: '#A8402C',
    textDecorationLine: 'underline',
  },
});
