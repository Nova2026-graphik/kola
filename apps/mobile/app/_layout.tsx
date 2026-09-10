import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { openDatabase } from '../src/db/client';
import { initRepositories } from '../src/repositories';

/**
 * Racine de l'application.
 *
 * Ce layout ne fait aucun appel réseau. Il ouvre la base locale, applique les
 * migrations, puis rend l'écran suivant — qui s'affiche depuis SQLite, réseau
 * ou pas (ADR-0002).
 *
 * La restauration de session arrive en #23, la redirection conditionnelle vers
 * `(auth)` ou `(app)` avec elle.
 */

type BootState = { status: 'ready' } | { status: 'failed'; error: string };

/**
 * Ouvre la base et applique les migrations.
 *
 * Synchrone et rapide — SQLite est local. Le faire au premier rendu plutôt que
 * dans un effet évite un rendu en cascade, et garantit surtout que les écrans
 * enfants ne s'exécutent jamais avant que la base soit prête.
 *
 * Une migration ratée laisse une base inutilisable qu'on ne peut pas réparer à
 * distance : mieux vaut l'annoncer que planter sans explication.
 */
function bootstrap(): BootState {
  try {
    openDatabase();
    initRepositories();
    return { status: 'ready' };
  } catch (error) {
    return {
      status: 'failed',
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export default function RootLayout(): React.JSX.Element {
  const [boot] = useState<BootState>(bootstrap);

  return (
    <GestureHandlerRootView style={styles.root}>
      <SafeAreaProvider>
        <StatusBar style="auto" />
        {boot.status === 'failed' ? (
          <BootError message={boot.error} />
        ) : (
          <Stack screenOptions={{ headerShown: false }}>
            <Stack.Screen name="(app)" />
            <Stack.Screen name="(auth)" />
          </Stack>
        )}
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}

function BootError({ message }: { readonly message: string }): React.JSX.Element {
  return (
    <View style={styles.error}>
      <Text style={styles.errorTitle}>Kola n’a pas pu démarrer</Text>
      <Text style={styles.errorText}>
        La base locale n’a pas pu être préparée. Réinstaller l’application effacerait les messages
        non envoyés : contactez-nous avant.
      </Text>
      <Text style={styles.errorDetail}>{message}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: '#FFFFFF',
  },
  error: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 32,
    gap: 12,
    backgroundColor: '#FFFFFF',
  },
  errorTitle: {
    fontSize: 18,
    fontWeight: '600',
    color: '#1A1A1A',
  },
  errorText: {
    fontSize: 14,
    lineHeight: 20,
    textAlign: 'center',
    color: '#6A6A6A',
  },
  errorDetail: {
    fontSize: 11,
    textAlign: 'center',
    color: '#A0A0A0',
  },
});
