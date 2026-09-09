import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SafeAreaProvider } from 'react-native-safe-area-context';

/**
 * Racine de l'application.
 *
 * Ce layout ne fait volontairement aucun appel réseau : au démarrage, l'écran
 * suivant doit s'afficher depuis la base locale, réseau ou pas.
 * Voir docs/adr/0002-architecture-local-first.md.
 *
 * La restauration de session arrive en #23, la redirection conditionnelle
 * vers `(auth)` ou `(app)` avec elle.
 */
export default function RootLayout() {
  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <SafeAreaProvider>
        <StatusBar style="auto" />
        <Stack screenOptions={{ headerShown: false }}>
          <Stack.Screen name="(app)" />
          <Stack.Screen name="(auth)" />
        </Stack>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}
