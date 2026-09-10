import { USERNAME_MAX_LENGTH, USERNAME_MIN_LENGTH } from './constants';

/**
 * Pseudo (#22).
 *
 * Il sert à se faire trouver sans partager son numéro — une alternative
 * importante à la découverte par carnet d'adresses, pour qui ne souhaite pas
 * exposer son téléphone.
 *
 * Les règles reproduisent exactement la contrainte SQL de `profiles.username`
 * (#8) : minuscules, chiffres, tiret bas, 3 à 24 caractères. L'unicité réelle
 * est garantie par la base ; ce qui est ici n'est qu'un retour immédiat.
 */

export type UsernameError =
  'empty' | 'too-short' | 'too-long' | 'invalid-characters' | 'starts-with-digit' | 'reserved';

/**
 * Pseudos réservés.
 *
 * Ils prêteraient à confusion dans une conversation ou permettraient de se
 * faire passer pour le service lui-même.
 */
const RESERVED = new Set([
  'admin',
  'kola',
  'support',
  'help',
  'aide',
  'moderation',
  'moderateur',
  'systeme',
  'system',
  'root',
  'me',
  'moi',
]);

export type UsernameResult =
  | { readonly ok: true; readonly value: string }
  | { readonly ok: false; readonly error: UsernameError };

/**
 * Normalise et valide un pseudo saisi.
 *
 * La normalisation en minuscules est appliquée avant validation : refuser
 * « Kofi » alors que « kofi » est accepté serait incompréhensible pour
 * l'utilisateur, qui ne voit pas la contrainte.
 */
export function validateUsername(input: string): UsernameResult {
  const value = input.trim().toLowerCase();

  if (value === '') {
    return { ok: false, error: 'empty' };
  }
  if (value.length < USERNAME_MIN_LENGTH) {
    return { ok: false, error: 'too-short' };
  }
  if (value.length > USERNAME_MAX_LENGTH) {
    return { ok: false, error: 'too-long' };
  }
  if (!/^[a-z0-9_]+$/u.test(value)) {
    return { ok: false, error: 'invalid-characters' };
  }
  if (/^\d/u.test(value)) {
    // Un pseudo tout en chiffres se confondrait avec un numéro de téléphone
    // dans les résultats de recherche.
    return { ok: false, error: 'starts-with-digit' };
  }
  if (RESERVED.has(value)) {
    return { ok: false, error: 'reserved' };
  }

  return { ok: true, value };
}

export function usernameErrorMessage(error: UsernameError, locale: 'fr' | 'en' = 'fr'): string {
  const messages: Record<UsernameError, { fr: string; en: string }> = {
    empty: { fr: 'Choisissez un pseudo.', en: 'Choose a username.' },
    'too-short': {
      fr: `Au moins ${String(USERNAME_MIN_LENGTH)} caractères.`,
      en: `At least ${String(USERNAME_MIN_LENGTH)} characters.`,
    },
    'too-long': {
      fr: `Au plus ${String(USERNAME_MAX_LENGTH)} caractères.`,
      en: `At most ${String(USERNAME_MAX_LENGTH)} characters.`,
    },
    'invalid-characters': {
      // Le message dit ce qui est autorisé, pas ce qui est interdit : c'est
      // plus court à lire et plus facile à corriger.
      fr: 'Lettres sans accent, chiffres et tiret bas uniquement.',
      en: 'Letters, digits and underscore only.',
    },
    'starts-with-digit': {
      fr: 'Le pseudo doit commencer par une lettre.',
      en: 'The username must start with a letter.',
    },
    reserved: {
      fr: 'Ce pseudo est réservé. Choisissez-en un autre.',
      en: 'This username is reserved. Please pick another.',
    },
  };
  return messages[error][locale];
}

/** Nom affiché : le seul champ vraiment obligatoire du profil. */
export function validateDisplayName(input: string): boolean {
  const value = input.trim();
  return value.length >= 1 && value.length <= 64;
}
