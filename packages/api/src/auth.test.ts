import type { AuthError } from '@supabase/supabase-js';
import { describe, expect, it } from 'vitest';

import { classifyAuthError } from './auth-errors';

/**
 * Le message brut de Supabase ne doit jamais atteindre l'utilisateur : il est
 * en anglais, technique, et parfois révélateur d'informations qui ne le
 * concernent pas. Cette traduction est donc sur le chemin de chaque erreur.
 */

function authError(message: string, status?: number): AuthError {
  return { message, status, name: 'AuthApiError' } as AuthError;
}

describe('classification des erreurs d’authentification', () => {
  it('ne signale rien quand il n’y a pas d’erreur', () => {
    expect(classifyAuthError(null)).toBeUndefined();
  });

  it('reconnaît une coupure réseau', () => {
    // Transitoire par nature : l'utilisateur doit comprendre qu'il n'a rien
    // fait de mal.
    expect(classifyAuthError(authError('Network request failed'))).toBe('network');
    expect(classifyAuthError(authError('failed to fetch'))).toBe('network');
    expect(classifyAuthError(authError('boum', 0))).toBe('network');
  });

  it('reconnaît une limitation de débit', () => {
    expect(classifyAuthError(authError('rate limit exceeded', 429))).toBe('too-many-attempts');
    expect(classifyAuthError(authError('Too many requests'))).toBe('too-many-attempts');
  });

  it('reconnaît un code expiré', () => {
    expect(classifyAuthError(authError('Token has expired', 401))).toBe('expired');
  });

  it('reconnaît un code faux', () => {
    expect(classifyAuthError(authError('Invalid token', 401))).toBe('wrong-code');
    expect(classifyAuthError(authError('refusé', 403))).toBe('wrong-code');
  });

  it('donne la priorité à l’expiration sur le code faux', () => {
    // Les deux messages contiennent « token » : l'expiration est plus précise
    // et appelle une action différente — redemander plutôt que retaper.
    expect(classifyAuthError(authError('Token has expired', 401))).not.toBe('wrong-code');
  });

  it('retombe sur un cas générique plutôt que de laisser passer le message brut', () => {
    expect(classifyAuthError(authError('quelque chose d’inattendu', 500))).toBe('unknown');
  });
});
