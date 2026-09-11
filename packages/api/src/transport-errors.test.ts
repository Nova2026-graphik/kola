import type { PostgrestError } from '@supabase/supabase-js';
import { describe, expect, it } from 'vitest';

import { isPermanentFailure } from '@kola/core';

import { toTransportError } from './transport-errors';

/**
 * La traduction d'une erreur PostgREST décide du comportement du moteur.
 *
 * Se tromper ici coûte cher dans les deux sens : classer un refus RLS comme
 * transitoire ferait réessayer indéfiniment, épuisant batterie et forfait sans
 * jamais aboutir ; classer une coupure réseau comme définitive perdrait un
 * message que l'utilisateur croit envoyé.
 */

function pgError(code: string, message = 'erreur'): PostgrestError {
  return { code, message, details: '', hint: '' } as PostgrestError;
}

describe('traduction des erreurs PostgREST', () => {
  it('rend définitif un refus de policy RLS', () => {
    const error = toTransportError(pgError('42501', 'new row violates row-level security'));

    expect(error.status).toBe(403);
    // La policy ne changera pas d'avis à la tentative suivante.
    expect(isPermanentFailure(error.status)).toBe(true);
  });

  it('rend définitive une violation de contrainte', () => {
    // Charge utile invalide : la réémettre ne servirait à rien.
    expect(isPermanentFailure(toTransportError(pgError('23514')).status)).toBe(true);
    expect(isPermanentFailure(toTransportError(pgError('23503')).status)).toBe(true);
  });

  it('rend transitoire une absence de réponse', () => {
    const error = toTransportError(pgError('', 'TypeError: failed to fetch'));

    expect(error.status).toBeNull();
    // Coupure réseau : le message doit rester en file.
    expect(isPermanentFailure(error.status)).toBe(false);
  });

  it('rend transitoire une erreur serveur inconnue', () => {
    const error = toTransportError(pgError('XX000', 'internal error'));

    expect(error.status).toBe(500);
    expect(isPermanentFailure(error.status)).toBe(false);
  });

  it('signale une violation d’unicité en 409', () => {
    // C'est le cas de l'idempotence : le moteur le traite à part.
    expect(toTransportError(pgError('23505')).status).toBe(409);
  });

  it('conserve le message d’origine pour le diagnostic', () => {
    const error = toTransportError(pgError('42501', 'policy « messages_insert » violée'));
    expect(error.message).toContain('messages_insert');
  });
});
