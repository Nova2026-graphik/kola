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
  // Compte propriétaire du projet EAS. L'équipe voit les builds et peut les
  // installer sans partager d'identifiants personnels (#75).
  owner: 'nova2026s-team',
  scheme: 'kola',
  version: '0.1.0',
  orientation: 'portrait',
  userInterfaceStyle: 'automatic',
  icon: './assets/icon.png',

  /**
   * Mises à jour à distance (#78).
   *
   * `fingerprint` plutôt qu'`appVersion` : la version d'exécution est calculée
   * à partir du projet natif lui-même. Ajouter une dépendance native change
   * l'empreinte, donc les applications déjà installées cessent d'être éligibles
   * à cette mise à jour et gardent la leur, au lieu de télécharger un JavaScript
   * qui appellerait un module absent et planterait au démarrage.
   *
   * C'est la différence entre une mise à jour qui ne s'applique pas — visible,
   * réparable par un nouveau build — et un parc d'appareils qui ne démarre plus.
   */
  runtimeVersion: { policy: 'fingerprint' },

  updates: {
    url: 'https://u.expo.dev/c47eb463-3f64-436b-ade3-2c50a9d9b24d',
    // Le client vérifie au lancement, mais n'attend pas : l'application doit
    // s'ouvrir sur la base locale même sans réseau (ADR-0002). La mise à jour
    // téléchargée s'applique au démarrage suivant.
    fallbackToCacheTimeout: 0,
    checkAutomatically: 'ON_LOAD',
  },

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
    'expo-updates',
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
    // Identifiant du projet EAS. Public par nature — il figure dans le bundle
    // et sert à résoudre le serveur de mises à jour.
    eas: { projectId: 'c47eb463-3f64-436b-ade3-2c50a9d9b24d' },
  },
};

export default config;
