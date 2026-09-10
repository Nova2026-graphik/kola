import { describe, expect, it } from 'vitest';

import { validateDisplayName, validateUsername, usernameErrorMessage } from './username';

describe('pseudo', () => {
  it('accepte une forme courante', () => {
    const result = validateUsername('kofi_2026');
    expect(result.ok).toBe(true);
    expect(result.ok === true && result.value).toBe('kofi_2026');
  });

  it('normalise en minuscules', () => {
    // Refuser « Kofi » alors que « kofi » passe serait incompréhensible :
    // l'utilisateur ne voit pas la contrainte.
    const result = validateUsername('Kofi');
    expect(result.ok === true && result.value).toBe('kofi');
  });

  it('ignore les espaces autour', () => {
    const result = validateUsername('  ama  ');
    expect(result.ok === true && result.value).toBe('ama');
  });

  it('refuse un pseudo vide', () => {
    expect(validateUsername('').ok).toBe(false);
    expect(validateUsername('   ').ok === false).toBe(true);
  });

  it('applique les bornes de longueur du schéma', () => {
    expect(validateUsername('ab').ok).toBe(false);
    expect(validateUsername('abc').ok).toBe(true);
    expect(validateUsername('a'.repeat(24)).ok).toBe(true);
    expect(validateUsername('a'.repeat(25)).ok).toBe(false);
  });

  it('refuse les accents et les espaces', () => {
    // La contrainte SQL de #8 n'accepte que [a-z0-9_].
    expect(validateUsername('kofi é').ok).toBe(false);
    expect(validateUsername('kofi mensah').ok).toBe(false);
    expect(validateUsername('kofi-mensah').ok).toBe(false);
  });

  it('refuse un pseudo commençant par un chiffre', () => {
    // Un pseudo tout en chiffres se confondrait avec un numéro de téléphone
    // dans les résultats de recherche.
    const result = validateUsername('228901234');
    expect(result.ok === false && result.error).toBe('starts-with-digit');
  });

  it('refuse les pseudos réservés, quelle que soit la casse', () => {
    expect(validateUsername('admin').ok).toBe(false);
    expect(validateUsername('KOLA').ok).toBe(false);
    expect(validateUsername('support').ok).toBe(false);
  });

  it('accepte le tiret bas au milieu et à la fin', () => {
    expect(validateUsername('ama_k').ok).toBe(true);
    expect(validateUsername('ama_').ok).toBe(true);
  });
});

describe('messages d’erreur', () => {
  it('dit ce qui est autorisé plutôt que ce qui est interdit', () => {
    // Plus court à lire, plus facile à corriger.
    expect(usernameErrorMessage('invalid-characters')).toContain('uniquement');
  });

  it('couvre toutes les erreurs dans les deux langues', () => {
    const errors = [
      'empty',
      'too-short',
      'too-long',
      'invalid-characters',
      'starts-with-digit',
      'reserved',
    ] as const;

    for (const error of errors) {
      expect(usernameErrorMessage(error, 'fr').length).toBeGreaterThan(0);
      expect(usernameErrorMessage(error, 'en').length).toBeGreaterThan(0);
    }
  });
});

describe('nom affiché', () => {
  it('accepte un nom ordinaire', () => {
    expect(validateDisplayName('Kofi Mensah')).toBe(true);
  });

  it('accepte accents et espaces, contrairement au pseudo', () => {
    // Le nom affiché est libre : c'est le pseudo qui porte les contraintes
    // techniques.
    expect(validateDisplayName('Komlan Kwadzo Mawuli Adjovi-Agbeko')).toBe(true);
    expect(validateDisplayName('Éric N’Douye')).toBe(true);
  });

  it('refuse un nom vide', () => {
    expect(validateDisplayName('')).toBe(false);
    expect(validateDisplayName('   ')).toBe(false);
  });

  it('refuse un nom démesuré', () => {
    expect(validateDisplayName('a'.repeat(65))).toBe(false);
  });
});
