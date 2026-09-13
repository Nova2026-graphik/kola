import type { KolaClient } from './client';
import { toTransportError } from './transport-errors';

/**
 * Enregistrement de l'appareil et de son jeton push (#57).
 *
 * Le jeton est lié à l'APPAREIL, pas au compte : deux personnes qui se
 * connectent tour à tour sur le même téléphone ne doivent pas se partager un
 * jeton, et la même personne sur deux téléphones doit recevoir sur les deux.
 * D'où une table `devices` plutôt qu'une colonne sur le profil.
 */

export interface EnregistrementAppareil {
  /** Identifiant stable de l'installation, généré sur l'appareil. */
  readonly deviceId: string;
  readonly userId: string;
  readonly pushToken: string | null;
  readonly platform: 'ios' | 'android';
  readonly appVersion: string | null;
}

/**
 * Écrit ou met à jour la ligne de cet appareil.
 *
 * Le jeton porte un index unique partiel : le système le réattribue parfois à
 * un autre appareil, et sans cette unicité la même notification partirait deux
 * fois. On efface donc d'abord le jeton partout ailleurs.
 */
export async function registerDevice(
  supabase: KolaClient,
  appareil: EnregistrementAppareil,
): Promise<void> {
  if (appareil.pushToken !== null) {
    // Volontairement avant l'écriture, pas après : l'inverse ferait échouer
    // l'insertion sur la contrainte d'unicité, et l'appareil resterait sans
    // jeton alors que c'est lui qui le détient désormais.
    const { error } = await supabase
      .from('devices')
      .update({ push_token: null })
      .eq('push_token', appareil.pushToken)
      .neq('id', appareil.deviceId);

    if (error) {
      throw toTransportError(error);
    }
  }

  const { error } = await supabase.from('devices').upsert(
    {
      id: appareil.deviceId,
      user_id: appareil.userId,
      push_token: appareil.pushToken,
      platform: appareil.platform,
      app_version: appareil.appVersion,
      last_seen_at: new Date().toISOString(),
    },
    { onConflict: 'id' },
  );

  if (error) {
    throw toTransportError(error);
  }
}

/**
 * Coupe les notifications pour cet appareil.
 *
 * Appelé à la déconnexion. Le jeton est vidé, la ligne reste : l'appareil
 * existe toujours, et sa prochaine connexion réécrira simplement son jeton.
 * Supprimer la ligne perdrait l'identifiant d'installation sans rien gagner.
 */
export async function clearPushToken(supabase: KolaClient, deviceId: string): Promise<void> {
  const { error } = await supabase.from('devices').update({ push_token: null }).eq('id', deviceId);

  if (error) {
    throw toTransportError(error);
  }
}

/** Le jeton actuellement connu du serveur pour cet appareil. */
export async function fetchKnownToken(
  supabase: KolaClient,
  deviceId: string,
): Promise<string | null> {
  const { data, error } = await supabase
    .from('devices')
    .select('push_token')
    .eq('id', deviceId)
    .maybeSingle();

  if (error) {
    throw toTransportError(error);
  }
  return data?.push_token ?? null;
}
