import type { AuthError } from '@supabase/supabase-js';

import type { OtpError } from '@kola/core';

/**
 * Traduit une erreur Supabase en cas métier.
 *
 * Le message brut ne doit jamais atteindre l'utilisateur : il est en anglais,
 * technique, et parfois révélateur d'informations qui ne le concernent pas.
 */
export function classifyAuthError(error: AuthError | null): OtpError | undefined {
  if (!error) {
    return undefined;
  }

  const status = error.status;
  const message = error.message.toLowerCase();

  // Le message est examiné AVANT le statut. Un `status` absent ne signifie pas
  // « coupure réseau » : beaucoup d'erreurs applicatives n'en portent pas, et
  // les traiter comme transitoires ferait réessayer indéfiniment une demande
  // qui n'aboutira jamais.
  if (message.includes('rate limit') || message.includes('too many')) {
    return 'too-many-attempts';
  }
  if (message.includes('expired')) {
    return 'expired';
  }
  if (message.includes('network') || message.includes('fetch')) {
    return 'network';
  }

  if (status === 429) {
    return 'too-many-attempts';
  }
  // `status: 0` explicite : la requête n'a pas abouti du tout.
  if (status === 0) {
    return 'network';
  }
  if (
    status === 401 ||
    status === 403 ||
    message.includes('invalid') ||
    message.includes('token')
  ) {
    return 'wrong-code';
  }
  return 'unknown';
}
