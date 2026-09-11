import type { SyncStatus } from './types';

/**
 * État d'acheminement affiché sur une bulle de message.
 *
 * L'honnêteté de ces états décide de la confiance qu'on peut accorder à
 * l'application. Beaucoup de messageries confondent « en attente » et
 * « envoyé », et laissent croire qu'un message est parti alors qu'il dort dans
 * une file. Sur un réseau intermittent, cette confusion se paie cher : on
 * range son téléphone en croyant avoir prévenu quelqu'un.
 *
 * Les cinq états sont donc distincts, et chacun se lit sans ambiguïté.
 */
export type DeliveryState =
  /** Écrit localement, pas encore parti. */
  | 'pending'
  /** Reçu par le serveur. */
  | 'sent'
  /** Arrivé sur l'appareil d'au moins un destinataire. */
  | 'delivered'
  /** Lu par au moins un destinataire. */
  | 'read'
  /** Abandonné après épuisement des tentatives, ou refusé définitivement. */
  | 'failed';

export interface DeliveryInput {
  readonly syncStatus: SyncStatus;
  /** Identifiant serveur : nul tant que le message n'est pas parti. */
  readonly serverId: string | null;
  /** Nombre de destinataires ayant reçu le message. */
  readonly deliveredCount?: number;
  /** Nombre de destinataires l'ayant lu. */
  readonly readCount?: number;
}

/**
 * Dérive l'état affiché.
 *
 * L'ordre des tests compte : un message peut être `sent` côté file et déjà lu
 * côté accusés, et c'est alors l'information la plus avancée qui prime.
 */
export function deliveryStateOf(input: DeliveryInput): DeliveryState {
  if (input.syncStatus === 'failed') {
    return 'failed';
  }

  // Tant qu'il n'y a pas d'identifiant serveur, le message n'est pas parti,
  // quoi que dise le reste. C'est le garde-fou contre l'affichage optimiste
  // qui mentirait.
  if (input.syncStatus === 'pending' || input.serverId === null) {
    return 'pending';
  }

  if ((input.readCount ?? 0) > 0) {
    return 'read';
  }
  if ((input.deliveredCount ?? 0) > 0) {
    return 'delivered';
  }
  return 'sent';
}

/** Un état sur lequel l'utilisateur peut agir. */
export function isRetryable(state: DeliveryState): boolean {
  return state === 'failed';
}

/**
 * Libellé pour le lecteur d'écran.
 *
 * Jamais de simple icône : une coche double ne dit rien à qui ne voit pas
 * l'écran, et l'état d'un message est une information, pas une décoration
 * (#64).
 */
export function deliveryLabel(state: DeliveryState, locale: 'fr' | 'en' = 'fr'): string {
  const labels: Record<DeliveryState, { fr: string; en: string }> = {
    pending: { fr: 'en attente d’envoi', en: 'waiting to send' },
    sent: { fr: 'envoyé', en: 'sent' },
    delivered: { fr: 'reçu', en: 'delivered' },
    read: { fr: 'lu', en: 'read' },
    failed: { fr: 'échec de l’envoi, toucher pour réessayer', en: 'failed, tap to retry' },
  };
  return labels[state][locale];
}

/**
 * Message du bandeau récapitulatif, quand des messages attendent (#32).
 *
 * Retourne `null` quand il n'y a rien à dire : un bandeau permanent devient
 * invisible, et le silence est une information en soi.
 */
export function pendingSummary(
  pendingCount: number,
  failedCount: number,
  locale: 'fr' | 'en' = 'fr',
): string | null {
  const en = locale === 'en';

  if (failedCount > 0) {
    return en
      ? `${String(failedCount)} message${failedCount > 1 ? 's' : ''} not sent`
      : `${String(failedCount)} message${failedCount > 1 ? 's' : ''} non envoyé${failedCount > 1 ? 's' : ''}`;
  }

  if (pendingCount > 0) {
    // Le ton importe : ce n'est pas une erreur, c'est un état normal du
    // produit. L'utilisateur doit savoir que ses messages ne sont pas perdus.
    return en
      ? `${String(pendingCount)} message${pendingCount > 1 ? 's' : ''} waiting for the network`
      : `${String(pendingCount)} message${pendingCount > 1 ? 's' : ''} en attente du réseau`;
  }

  return null;
}
