import { describe, expect, it } from 'vitest';

import {
  formatE164ForDisplay,
  formatNationalNumber,
  isLikelyMobile,
  parsePhone,
  phoneErrorMessage,
  type ParsedPhone,
} from './phone';

/**
 * Un numéro refusé à cause d'un espace, c'est un utilisateur perdu. Ces tests
 * couvrent les formes que les gens tapent réellement, pas la forme canonique.
 */

function parsed(input: string): ParsedPhone {
  const result = parsePhone(input);
  if (!result.ok) {
    throw new Error(`attendu valide, obtenu ${result.error} pour « ${input} »`);
  }
  return result.value;
}

describe('numéro togolais sans indicatif', () => {
  it('applique +228 par défaut', () => {
    expect(parsed('90123456').e164).toBe('+22890123456');
  });

  it('accepte les espaces, comme les gens écrivent', () => {
    expect(parsed('90 12 34 56').e164).toBe('+22890123456');
  });

  it('accepte les tirets et les points', () => {
    expect(parsed('90-12-34-56').e164).toBe('+22890123456');
    expect(parsed('90.12.34.56').e164).toBe('+22890123456');
  });

  it('retire un zéro de tête', () => {
    // Convention d'autres pays, souvent recopiée par habitude. Le refuser
    // donnerait une erreur incompréhensible.
    expect(parsed('090123456').e164).toBe('+22890123456');
  });

  it('ignore les espaces autour', () => {
    expect(parsed('  90123456  ').e164).toBe('+22890123456');
  });
});

describe('numéro avec indicatif', () => {
  it('accepte la forme internationale', () => {
    expect(parsed('+22890123456').e164).toBe('+22890123456');
  });

  it('accepte le préfixe 00, encore très utilisé', () => {
    expect(parsed('0022890123456').e164).toBe('+22890123456');
  });

  it('accepte l’indicatif avec des espaces', () => {
    expect(parsed('+228 90 12 34 56').e164).toBe('+22890123456');
  });

  it('reconnaît les pays voisins', () => {
    expect(parsed('+22997123456').countryCode).toBe('+229');
    expect(parsed('+233201234567').countryCode).toBe('+233');
    expect(parsed('+2250712345678').countryCode).toBe('+225');
  });

  it('distingue +228 de +22, indicatifs plus longs d’abord', () => {
    // Le piège : « +22 » n'existe pas, mais un appariement naïf le prendrait.
    expect(parsed('+22890123456').countryCode).toBe('+228');
  });

  it('accepte un indicatif hors de la région connue', () => {
    const result = parsePhone('+33612345678');
    expect(result.ok).toBe(true);
  });
});

describe('numéros refusés', () => {
  it('refuse un champ vide', () => {
    const result = parsePhone('   ');
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toBe('empty');
  });

  it('refuse un numéro trop court', () => {
    const result = parsePhone('9012');
    expect(result.ok === false && result.error).toBe('too-short');
  });

  it('refuse un numéro trop long', () => {
    const result = parsePhone('901234567890');
    expect(result.ok === false && result.error).toBe('too-long');
  });

  it('refuse des lettres', () => {
    const result = parsePhone('90ABC456');
    expect(result.ok === false && result.error).toBe('invalid-characters');
  });

  it('valide la longueur nationale du pays reconnu', () => {
    // Le Ghana attend neuf chiffres : huit ne suffisent pas.
    expect(parsePhone('+23320123456').ok).toBe(false);
    expect(parsePhone('+233201234567').ok).toBe(true);
  });
});

describe('affichage', () => {
  it('groupe le numéro national par deux', () => {
    expect(formatNationalNumber(parsed('90123456'))).toBe('90 12 34 56');
  });

  it('affiche la forme complète lisible', () => {
    expect(formatE164ForDisplay('+22890123456')).toBe('+228 90 12 34 56');
  });

  it('rend le numéro tel quel s’il est invalide', () => {
    // Mieux vaut afficher quelque chose que de planter.
    expect(formatE164ForDisplay('pas-un-numéro')).toBe('pas-un-numéro');
  });
});

describe('détection de mobile', () => {
  it('reconnaît les préfixes mobiles togolais', () => {
    expect(isLikelyMobile(parsed('90123456'))).toBe(true);
    expect(isLikelyMobile(parsed('79123456'))).toBe(true);
  });

  it('signale un numéro qui ressemble à un fixe', () => {
    expect(isLikelyMobile(parsed('22123456'))).toBe(false);
  });

  it('ne prétend rien savoir hors du Togo', () => {
    // Refuser un numéro valide coûte un utilisateur : dans le doute, on laisse
    // passer et c'est le SMS qui tranchera.
    expect(isLikelyMobile(parsed('+233201234567'))).toBe(true);
  });
});

describe('messages d’erreur', () => {
  it('parle à l’utilisateur, pas au développeur', () => {
    expect(phoneErrorMessage('too-short')).toBe('Ce numéro est trop court.');
    expect(phoneErrorMessage('empty')).toContain('Entrez votre numéro');
  });

  it('couvre toutes les erreurs dans les deux langues', () => {
    const errors = [
      'empty',
      'too-short',
      'too-long',
      'invalid-characters',
      'invalid-country-code',
    ] as const;

    for (const error of errors) {
      expect(phoneErrorMessage(error, 'fr').length).toBeGreaterThan(0);
      expect(phoneErrorMessage(error, 'en').length).toBeGreaterThan(0);
    }
  });
});
