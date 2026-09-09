import type { ExpoConfig } from 'expo/config';

/**
 * Configuration de l'application Kola.
 *
 * Aucune valeur sensible ici : les URL et clés viennent de l'environnement,
 * injecté par profil EAS (#7, #75). `app.config.ts` est versionné, il ne doit
 * donc jamais contenir de secret.
 */

/** Fond de l'écran de démarrage et de l'icône adaptative. Identité définitive en #61. */
const BRAND_COLOR = '#A8402C';

const config: ExpoConfig = {
  name: 'Kola',
  slug: 'kola',
  scheme: 'kola',
  version: '0.1.0',
  orientation: 'portrait',
  userInterfaceStyle: 'automatic',
  icon: './assets/icon.png',

  ios: {
    bundleIdentifier: 'app.kola.mobile',
    supportsTablet: false,
    // iOS 15.1 est le plancher d'Expo SDK 57.
    infoPlist: {
      ITSAppUsesNonExemptEncryption: false,
    },
  },

  android: {
    package: 'app.kola.mobile',
    adaptiveIcon: {
      foregroundImage: './assets/adaptive-icon.png',
      backgroundColor: BRAND_COLOR,
    },
    // `minSdkVersion` est fixé plus bas via expo-build-properties : Android 9
    // (API 28) est le plancher imposé par le parc d'appareils visé.
    // Voir docs/adr/0006-budget-de-performance.md.
  },

  plugins: [
    'expo-router',
    'expo-status-bar',
    [
      // La liste des conversations doit s'afficher dès le premier rendu :
      // un écran de démarrage sobre vaut mieux qu'une animation coûteuse.
      'expo-splash-screen',
      {
        image: './assets/splash-icon.png',
        imageWidth: 180,
        resizeMode: 'contain',
        backgroundColor: BRAND_COLOR,
      },
    ],
    [
      'expo-build-properties',
      {
        android: {
          minSdkVersion: 28,
          // R8 réduit sensiblement la taille de l'APK, dont le budget est de 40 Mo.
          // Contrepartie : l'obfuscation casse la réflexion, d'où l'obligation de
          // tester en build release et pas seulement en développement (#76).
          enableProguardInReleaseBuilds: true,
          enableShrinkResourcesInReleaseBuilds: true,
        },
      },
    ],
  ],

  experiments: {
    typedRoutes: true,
  },

  extra: {
    supabaseUrl: process.env['EXPO_PUBLIC_SUPABASE_URL'] ?? null,
    supabaseAnonKey: process.env['EXPO_PUBLIC_SUPABASE_ANON_KEY'] ?? null,
  },
};

export default config;
