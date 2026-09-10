import type { Session, User } from '@supabase/supabase-js';

import type { OtpError } from '@kola/core';

import { classifyAuthError } from './auth-errors';
import { getClient } from './client';

/**
 * Authentification par code à usage unique (#19, #20, #21).
 *
 * Deux chemins : le numéro de téléphone, principal parce qu'au Togo bien plus
 * de gens ont un numéro qu'une adresse e-mail active ; et l'e-mail, en repli,
 * qui ne coûte rien par envoi et sert aux tests de l'équipe sans consommer de
 * crédits SMS.
 */

export interface AuthResult {
  readonly ok: boolean;
  readonly error?: OtpError | undefined;
}

export interface SessionResult {
  readonly ok: boolean;
  readonly session?: Session | undefined;
  readonly user?: User | undefined;
  readonly error?: OtpError | undefined;
}

/**
 * Envoie un code par SMS.
 *
 * ⚠️ Nécessite un fournisseur SMS configuré côté Supabase (Twilio, Vonage ou
 * une passerelle locale). Sans lui, l'appel échoue côté serveur : le code de
 * cette fonction est complet, sa vérification de bout en bout ne l'est pas.
 */
export async function sendPhoneOtp(phoneE164: string): Promise<AuthResult> {
  const { error } = await getClient().auth.signInWithOtp({
    phone: phoneE164,
    options: {
      // L'inscription et la connexion sont le même geste : demander à
      // l'utilisateur s'il a déjà un compte est une friction inutile.
      shouldCreateUser: true,
    },
  });

  return error ? { ok: false, error: classifyAuthError(error) } : { ok: true };
}

/** Envoie un code à six chiffres par e-mail. */
export async function sendEmailOtp(email: string): Promise<AuthResult> {
  const { error } = await getClient().auth.signInWithOtp({
    email,
    options: {
      // Pas de lien magique : le gabarit d'e-mail est configuré côté Supabase
      // pour envoyer un code à six chiffres. Un lien suppose d'ouvrir un client
      // mail puis de revenir — parcours fragile sur mobile, impossible hors
      // réseau.
      shouldCreateUser: true,
    },
  });

  return error ? { ok: false, error: classifyAuthError(error) } : { ok: true };
}

export type OtpChannel = { readonly phone: string } | { readonly email: string };

/** Vérifie le code et ouvre la session. */
export async function verifyOtp(channel: OtpChannel, token: string): Promise<SessionResult> {
  const { data, error } =
    'phone' in channel
      ? await getClient().auth.verifyOtp({ phone: channel.phone, token, type: 'sms' })
      : await getClient().auth.verifyOtp({ email: channel.email, token, type: 'email' });

  if (error) {
    return { ok: false, error: classifyAuthError(error) };
  }
  if (!data.session || !data.user) {
    return { ok: false, error: 'unknown' };
  }

  return { ok: true, session: data.session, user: data.user };
}

/** Session courante, restaurée depuis le stockage sécurisé. */
export async function getSession(): Promise<Session | null> {
  const { data } = await getClient().auth.getSession();
  return data.session;
}

/**
 * Notifie chaque changement de session.
 *
 * Sert à réagir à l'expiration du jeton de rafraîchissement, qui doit ramener
 * à l'authentification **sans effacer les données locales** : l'historique
 * déjà synchronisé reste lisible (ADR-0002).
 */
export function onAuthChange(listener: (session: Session | null) => void): () => void {
  const { data } = getClient().auth.onAuthStateChange((_event, session) => {
    listener(session);
  });
  return () => {
    data.subscription.unsubscribe();
  };
}

export async function signOut(): Promise<void> {
  await getClient().auth.signOut();
}
