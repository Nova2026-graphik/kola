import type { PostgrestError } from '@supabase/supabase-js';

import { TransportError } from '@kola/core';

/** Violation d'unicité — le code d'erreur Postgres, pas un message. */
export const UNIQUE_VIOLATION = '23505';
/** Violation de policy RLS, ou droits insuffisants. */
export const INSUFFICIENT_PRIVILEGE = '42501';

/**
 * Traduit une erreur PostgREST en `TransportError`.
 *
 * Le statut HTTP décide de tout côté moteur : réessayer indéfiniment un refus
 * RLS épuiserait la batterie et le forfait sans jamais aboutir, tandis
 * qu'abandonner sur une coupure perdrait un message que l'utilisateur croit
 * envoyé (`isPermanentFailure`).
 */
export function toTransportError(error: PostgrestError): TransportError {
  if (error.code === INSUFFICIENT_PRIVILEGE) {
    // Définitif : la policy ne changera pas d'avis à la tentative suivante.
    return new TransportError(error.message, 403);
  }
  if (error.code === UNIQUE_VIOLATION) {
    return new TransportError(error.message, 409);
  }
  if (error.code === '23503' || error.code === '23514') {
    // Clé étrangère ou contrainte de validation : la charge utile est
    // invalide, la réémettre ne servirait à rien.
    return new TransportError(error.message, 422);
  }
  if (error.code === '' || error.message.toLowerCase().includes('fetch')) {
    // Pas de réponse : coupure réseau, donc transitoire.
    return new TransportError(error.message, null);
  }
  return new TransportError(error.message, 500);
}

/**
 * Le client est injecté plutôt que lu d'un singleton.
 *
 * Ce n'est pas de l'abstraction gratuite : sans cela, ce module importerait
 * `supabase-js` au runtime et deviendrait intestable — or c'est le point de
 * contact entre le moteur d'envoi et le serveur, celui dont les erreurs de
 * traduction se paient en messages perdus ou réessayés à l'infini.
 */
