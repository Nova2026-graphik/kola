import { DEFAULT_COUNTRY_CALLING_CODE } from './constants';

/**
 * Normalisation et validation des numéros de téléphone (#19).
 *
 * Au Togo, le numéro de téléphone est l'identité numérique de fait : bien plus
 * de gens ont un numéro qu'une adresse e-mail active. C'est donc le chemin
 * d'inscription principal, et il doit accepter le numéro tel que les gens
 * l'écrivent réellement — avec des espaces, des tirets, un zéro en tête hérité
 * d'autres pays, ou l'indicatif sous ses trois formes.
 *
 * Un numéro refusé à cause d'un espace, c'est un utilisateur perdu.
 */

/** Longueur nationale attendue, par indicatif. */
const NATIONAL_LENGTHS: Record<string, number> = {
  '+228': 8, // Togo
  '+229': 8, // Bénin
  '+233': 9, // Ghana
  '+225': 10, // Côte d'Ivoire
  '+226': 8, // Burkina Faso
  '+227': 8, // Niger
  '+221': 9, // Sénégal
  '+223': 8, // Mali
};

/**
 * Préfixes mobiles togolais connus.
 *
 * Les numéros togolais comptent huit chiffres et les mobiles commencent par 7
 * (Moov Africa) ou 9 (Togocom). Un numéro fixe commence par 2.
 *
 * ⚠️ Cette liste est indicative et doit être confirmée auprès des opérateurs
 * avant la mise en production : les plans de numérotation évoluent, et refuser
 * un numéro valide coûte un utilisateur. En cas de doute, `isLikelyMobile`
 * sert à AVERTIR, jamais à bloquer.
 */
const TOGO_MOBILE_PREFIXES = ['7', '9'] as const;

export interface ParsedPhone {
  readonly e164: string;
  readonly countryCode: string;
  readonly nationalNumber: string;
}

export type PhoneError =
  'empty' | 'too-short' | 'too-long' | 'invalid-characters' | 'invalid-country-code';

export type PhoneResult =
  | { readonly ok: true; readonly value: ParsedPhone }
  | { readonly ok: false; readonly error: PhoneError };

/**
 * Normalise un numéro saisi vers le format E.164.
 *
 * Accepte les formes réellement tapées : « 90 12 34 56 », « +228-90123456 »,
 * « 00228 90123456 », « 090123456 ». L'indicatif par défaut s'applique quand
 * le numéro n'en porte pas.
 */
export function parsePhone(
  input: string,
  defaultCountryCode: string = DEFAULT_COUNTRY_CALLING_CODE,
): PhoneResult {
  const raw = input.trim();
  if (raw === '') {
    return { ok: false, error: 'empty' };
  }

  // Tout ce qui n'est ni chiffre ni « + » est de la mise en forme : espaces,
  // tirets, points, parenthèses. On les ignore plutôt que de refuser.
  const cleaned = raw.replace(/[\s.\-()/]/gu, '');

  if (!/^\+?\d+$/u.test(cleaned)) {
    return { ok: false, error: 'invalid-characters' };
  }

  let countryCode: string;
  let nationalNumber: string;

  if (cleaned.startsWith('+')) {
    const match = matchKnownCountryCode(cleaned);
    if (!match) {
      return { ok: false, error: 'invalid-country-code' };
    }
    countryCode = match.countryCode;
    nationalNumber = match.rest;
  } else if (cleaned.startsWith('00')) {
    // Préfixe international à l'ancienne, encore très utilisé.
    const match = matchKnownCountryCode(`+${cleaned.slice(2)}`);
    if (!match) {
      return { ok: false, error: 'invalid-country-code' };
    }
    countryCode = match.countryCode;
    nationalNumber = match.rest;
  } else {
    countryCode = defaultCountryCode;
    // Un zéro de tête est une convention nationale d'autres pays ; au Togo il
    // ne fait pas partie du numéro. Le retirer évite un refus incompréhensible.
    nationalNumber = cleaned.replace(/^0+/u, '');
  }

  const expected = NATIONAL_LENGTHS[countryCode];
  if (expected !== undefined) {
    if (nationalNumber.length < expected) {
      return { ok: false, error: 'too-short' };
    }
    if (nationalNumber.length > expected) {
      return { ok: false, error: 'too-long' };
    }
  } else {
    // Indicatif hors de la région connue : on s'en tient aux bornes E.164.
    if (nationalNumber.length < 4) {
      return { ok: false, error: 'too-short' };
    }
    if (countryCode.length - 1 + nationalNumber.length > 15) {
      return { ok: false, error: 'too-long' };
    }
  }

  return {
    ok: true,
    value: {
      e164: `${countryCode}${nationalNumber}`,
      countryCode,
      nationalNumber,
    },
  };
}

function matchKnownCountryCode(value: string): { countryCode: string; rest: string } | null {
  // Les indicatifs les plus longs d'abord : « +228 » avant « +22 ».
  const codes = Object.keys(NATIONAL_LENGTHS).sort((a, b) => b.length - a.length);

  for (const code of codes) {
    if (value.startsWith(code)) {
      return { countryCode: code, rest: value.slice(code.length) };
    }
  }

  // Indicatif inconnu : on accepte un à trois chiffres, comme le prévoit E.164.
  const generic = /^\+(\d{1,3})(\d+)$/u.exec(value);
  if (generic?.[1] !== undefined && generic[2] !== undefined) {
    return { countryCode: `+${generic[1]}`, rest: generic[2] };
  }
  return null;
}

/** Forme courte, à afficher : « 90 12 34 56 ». */
export function formatNationalNumber(phone: ParsedPhone): string {
  const groups = phone.nationalNumber.match(/.{1,2}/gu) ?? [];
  return groups.join(' ');
}

/** Forme complète, à afficher : « +228 90 12 34 56 ». */
export function formatE164ForDisplay(e164: string): string {
  const parsed = parsePhone(e164);
  if (!parsed.ok) {
    return e164;
  }
  return `${parsed.value.countryCode} ${formatNationalNumber(parsed.value)}`;
}

/**
 * Le numéro ressemble-t-il à un mobile ?
 *
 * Sert à AVERTIR, jamais à bloquer : les plans de numérotation évoluent, et
 * refuser un numéro valide coûte un utilisateur. Un faux négatif ici n'a aucune
 * conséquence — l'OTP arrivera ou non, et c'est le SMS qui tranchera.
 */
export function isLikelyMobile(phone: ParsedPhone): boolean {
  if (phone.countryCode !== '+228') {
    // Hors du Togo, on ne prétend rien savoir.
    return true;
  }
  return TOGO_MOBILE_PREFIXES.some((prefix) => phone.nationalNumber.startsWith(prefix));
}

/** Message d'erreur destiné à l'utilisateur, pas au développeur. */
export function phoneErrorMessage(error: PhoneError, locale: 'fr' | 'en' = 'fr'): string {
  const messages: Record<PhoneError, { fr: string; en: string }> = {
    empty: {
      fr: 'Entrez votre numéro de téléphone.',
      en: 'Enter your phone number.',
    },
    'too-short': {
      fr: 'Ce numéro est trop court.',
      en: 'This number is too short.',
    },
    'too-long': {
      fr: 'Ce numéro est trop long.',
      en: 'This number is too long.',
    },
    'invalid-characters': {
      fr: 'Ce numéro contient des caractères inattendus.',
      en: 'This number contains unexpected characters.',
    },
    'invalid-country-code': {
      fr: 'Cet indicatif pays n’est pas reconnu.',
      en: 'This country code is not recognised.',
    },
  };
  return messages[error][locale];
}

/** Indicatifs proposés dans le sélecteur, le Togo en tête. */
export const COUNTRY_CALLING_CODES = [
  { code: '+228', name: 'Togo', flag: '🇹🇬' },
  { code: '+229', name: 'Bénin', flag: '🇧🇯' },
  { code: '+233', name: 'Ghana', flag: '🇬🇭' },
  { code: '+225', name: "Côte d'Ivoire", flag: '🇨🇮' },
  { code: '+226', name: 'Burkina Faso', flag: '🇧🇫' },
  { code: '+227', name: 'Niger', flag: '🇳🇪' },
  { code: '+221', name: 'Sénégal', flag: '🇸🇳' },
  { code: '+223', name: 'Mali', flag: '🇲🇱' },
] as const;
