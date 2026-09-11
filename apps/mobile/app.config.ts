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
   * `runtimeVersion` dit à quel NATIF un paquet JavaScript est compatible. Une
   * mise à jour n'atteint que les applications dont la version d'exécution est
   * identique — c'est ce qui empêche d'envoyer un JavaScript qui appellerait un
   * module natif absent, et de transformer un correctif en parc qui ne démarre
   * plus.
   *
   * Trois façons de la fixer ; on prend la troisième.
   *
   * `fingerprint` la calcule depuis le projet natif, ce qui invalide
   * automatiquement les mises à jour quand une dépendance native change. C'est
   * séduisant, et c'est ce qui était configuré d'abord. Le build l'a rejeté :
   * « Runtime version calculated on local machine not equal to runtime version
   * calculated during build ». L'empreinte hache le contenu de `node_modules`,
   * que pnpm n'installe pas à l'identique sur un poste Windows et sur le
   * serveur Linux d'EAS. La concordance n'est donc pas garantie, et un build
   * lancé depuis un poste de développement échoue systématiquement.
   *
   * `appVersion` la lie à `version`. Écarté pour la raison inverse : on
   * incrémente `version` à chaque livraison, y compris purement JavaScript, et
   * chaque incrément couperait les applications installées de toutes les mises
   * à jour suivantes. La version commerciale et la compatibilité native n'ont
   * aucune raison d'avancer ensemble.
   *
   * Une valeur EXPLICITE sépare les deux. Elle ne bouge que lorsque le natif
   * change — nouvelle dépendance native, montée de SDK Expo, changement de
   * `expo-build-properties`. Tant qu'elle ne bouge pas, une correction part sur
   * les appareils déjà installés sans nouveau build.
   *
   * RÈGLE : incrémenter cette valeur dans le même commit que le changement
   * natif, et reconstruire. Une mise à jour publiée après un changement natif
   * sans incrément est le seul scénario qui casse un appareil à distance.
   */
  runtimeVersion: '1',

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
