import { OTP_LENGTH } from './constants';

/**
 * Code à usage unique (#19, #20, #21).
 *
 * C'est l'écran où l'on perd le plus d'utilisateurs. Chaque friction compte :
 * basculer vers l'application SMS, mémoriser six chiffres, revenir, se
 * tromper. Tout ce qui peut être automatisé ici l'est.
 */

/** Ne garde que les chiffres, et tronque à la longueur attendue. */
export function sanitizeOtp(input: string): string {
  return input.replace(/\D/gu, '').slice(0, OTP_LENGTH);
}

export function isCompleteOtp(input: string): boolean {
  return sanitizeOtp(input).length === OTP_LENGTH;
}

/**
 * Extrait le code d'un SMS reçu.
 *
 * Sur Android, l'API SMS Retriever remet le corps entier du message : il faut
 * y retrouver le code. On cherche la première suite d'exactement six chiffres
 * qui n'est pas collée à d'autres chiffres — sinon un numéro de téléphone ou
 * un identifiant présent dans le message serait pris pour le code.
 */
export function extractOtpFromMessage(message: string): string | null {
  const match = new RegExp(`(?<!\\d)(\\d{${String(OTP_LENGTH)}})(?!\\d)`, 'u').exec(message);
  return match?.[1] ?? null;
}

/**
 * Délai avant de pouvoir redemander un code.
 *
 * Il croît à chaque demande : les envois de SMS coûtent de l'argent réel, et
 * une demande répétée est le premier vecteur d'abus. Mais la première attente
 * reste courte, parce qu'un SMS qui tarde est un cas normal sur ce réseau et
 * que l'utilisateur ne doit pas se sentir puni.
 */
export const RESEND_DELAYS_MS = [30_000, 60_000, 120_000, 300_000] as const;

export function resendDelayMs(attempt: number): number {
  const index = Math.min(Math.max(attempt, 0), RESEND_DELAYS_MS.length - 1);
  return RESEND_DELAYS_MS[index] ?? RESEND_DELAYS_MS[RESEND_DELAYS_MS.length - 1] ?? 300_000;
}

/** Secondes restantes avant de pouvoir redemander. */
export function secondsUntilResend(availableAt: number, now: number): number {
  return Math.max(0, Math.ceil((availableAt - now) / 1000));
}

export function canResend(availableAt: number, now: number): boolean {
  return now >= availableAt;
}

/** Compte à rebours affiché : « 1:05 » ou « 45 s ». */
export function formatCountdown(seconds: number, locale: 'fr' | 'en' = 'fr'): string {
  if (seconds >= 60) {
    const minutes = Math.floor(seconds / 60);
    const rest = seconds % 60;
    return `${String(minutes)}:${rest.toString().padStart(2, '0')}`;
  }
  return locale === 'en' ? `${String(seconds)}s` : `${String(seconds)} s`;
}

// ---------------------------------------------------------------------------
// Limitation de débit côté client
// ---------------------------------------------------------------------------

/**
 * Nombre de demandes tolérées avant blocage prolongé.
 *
 * Le serveur limite aussi (#67) — c'est lui qui fait autorité, puisqu'un client
 * modifié contournerait celui-ci. La limitation côté client sert à éviter les
 * demandes involontaires et à donner un retour immédiat plutôt qu'une erreur
 * réseau incompréhensible.
 */
export const MAX_REQUESTS_PER_WINDOW = 5;
export const RATE_WINDOW_MS = 15 * 60_000;

export interface OtpRequestState {
  /** Horodatages des demandes récentes, du plus ancien au plus récent. */
  readonly attempts: readonly number[];
}

export const EMPTY_OTP_STATE: OtpRequestState = { attempts: [] };

export interface RequestDecision {
  readonly allowed: boolean;
  /** Instant à partir duquel une nouvelle demande sera possible. */
  readonly availableAt: number;
  readonly state: OtpRequestState;
}

/** Enregistre une demande et dit si elle est permise. */
export function requestOtp(state: OtpRequestState, now: number): RequestDecision {
  const recent = state.attempts.filter((at) => now - at < RATE_WINDOW_MS);

  if (recent.length >= MAX_REQUESTS_PER_WINDOW) {
    const oldest = recent[0] ?? now;
    return {
      allowed: false,
      availableAt: oldest + RATE_WINDOW_MS,
      state: { attempts: recent },
    };
  }

  const attempts = [...recent, now];
  return {
    allowed: true,
    availableAt: now + resendDelayMs(recent.length),
    state: { attempts },
  };
}

export type OtpError =
  'incomplete' | 'wrong-code' | 'expired' | 'too-many-attempts' | 'network' | 'unknown';

/** Message destiné à l'utilisateur. Aucun ne doit ressembler à une trace technique. */
export function otpErrorMessage(error: OtpError, locale: 'fr' | 'en' = 'fr'): string {
  const messages: Record<OtpError, { fr: string; en: string }> = {
    incomplete: {
      fr: 'Entrez les six chiffres du code.',
      en: 'Enter all six digits.',
    },
    'wrong-code': {
      fr: 'Ce code ne correspond pas. Vérifiez le SMS reçu.',
      en: 'This code does not match. Check the SMS you received.',
    },
    expired: {
      fr: 'Ce code a expiré. Demandez-en un nouveau.',
      en: 'This code has expired. Request a new one.',
    },
    'too-many-attempts': {
      fr: 'Trop de tentatives. Patientez quelques minutes.',
      en: 'Too many attempts. Please wait a few minutes.',
    },
    network: {
      // Hors ligne n'est pas une panne : c'est un état normal du produit.
      fr: 'Pas de réseau pour l’instant. Réessayez à la reconnexion.',
      en: 'No network right now. Try again once reconnected.',
    },
    unknown: {
      fr: 'La vérification n’a pas abouti. Réessayez.',
      en: 'Verification failed. Please try again.',
    },
  };
  return messages[error][locale];
}
