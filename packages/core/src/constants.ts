/**
 * Constantes partagées entre l'application mobile, les repositories et les Edge Functions.
 * Toute valeur dupliquée entre le client et le serveur finit par diverger : elle vit ici.
 */

/** Indicatif téléphonique par défaut (Togo, premier marché). */
export const DEFAULT_COUNTRY_CALLING_CODE = '+228';

/** Code ISO 3166-1 alpha-2 par défaut. */
export const DEFAULT_COUNTRY_CODE = 'TG';

/** Langues de l'interface. `ee` (éwé) et `kbp` (kabiyè) sont prévues mais non traduites en V1. */
export const SUPPORTED_LOCALES = ['fr', 'en', 'ee', 'kbp'] as const;

/** Langue de repli quand la traduction demandée est absente. */
export const FALLBACK_LOCALE = 'fr';

/**
 * Nombre de messages chargés par page.
 * Plus haut sature la mémoire d'un appareil à 2 Go, plus bas multiplie les requêtes.
 */
export const MESSAGE_PAGE_SIZE = 50;

/** Longueur du code OTP, pour le téléphone comme pour l'e-mail. */
export const OTP_LENGTH = 6;

/** Bornes du pseudo, alignées sur la contrainte SQL de `profiles.username`. */
export const USERNAME_MIN_LENGTH = 3;
export const USERNAME_MAX_LENGTH = 24;

/** Budgets de performance de l'ADR 0006. Mesurés en CI, ils font échouer le build. */
export const PERFORMANCE_BUDGETS = {
  /** Démarrage à froid jusqu'au premier écran utilisable, en millisecondes. */
  coldStartMs: 2000,
  /** Taille de l'APK de production, en octets. */
  apkSizeBytes: 40 * 1024 * 1024,
  /** Occupation mémoire après usage prolongé, en octets. */
  memoryBytes: 250 * 1024 * 1024,
} as const;
