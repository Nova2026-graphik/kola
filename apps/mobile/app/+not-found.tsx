import { Link, Stack } from 'expo-router';
import { StyleSheet, Text, View } from 'react-native';

/**
 * Route inconnue.
 *
 * Ce cas se produira surtout via un lien profond obsolète : lien d'invitation
 * révoqué (#40) ou notification pointant vers une conversation supprimée (#60).
 * Le message reste donc compréhensible plutôt que technique.
 */
export default function NotFoundScreen() {
  return (
    <>
      <Stack.Screen options={{ title: 'Page introuvable' }} />
      <View style={styles.container}>
        <Text style={styles.title}>Cette page n&apos;existe pas</Text>
        <Text style={styles.subtitle}>
          Le lien que vous avez suivi est peut-être expiré ou ne fonctionne plus.
        </Text>
        <Link href="/" style={styles.link}>
          Retour aux conversations
        </Link>
      </View>
    </>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 24,
    gap: 12,
    backgroundColor: '#FFFFFF',
  },
  title: {
    fontSize: 20,
    fontWeight: '600',
    color: '#1A1A1A',
  },
  subtitle: {
    fontSize: 15,
    textAlign: 'center',
    color: '#4A4A4A',
  },
  link: {
    marginTop: 8,
    fontSize: 16,
    color: '#A8402C',
    textDecorationLine: 'underline',
  },
});
