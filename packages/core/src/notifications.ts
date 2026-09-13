/**
 * Quand demander la permission de notifier, et quoi faire de la réponse (#57).
 *
 * Ce fichier ne contient que des décisions, aucun appel système : c'est ce qui
 * le rend testable sous Node, et c'est là que se trouvent les erreurs qui
 * coûtent cher. Un mauvais moment pour demander la permission ne se rattrape
 * pas — sur iOS, un refus est quasi définitif : l'utilisateur doit aller le
 * changer dans les réglages du système, ce que presque personne ne fait.
 */

export type PermissionNotification = 'accordee' | 'refusee' | 'jamais_demandee';

/**
 * Ce qui justifie de demander la permission.
 *
 * Jamais au premier lancement : à ce moment-là, l'application n'a encore rien
 * fait pour l'utilisateur, et la demande arrive comme une exigence. Après un
 * premier message envoyé ou reçu, elle répond à un besoin qu'il vient de
 * constater — « prévenez-moi quand on me répond » se comprend tout seul.
 */
export type MomentDemande = 'premier_message_envoye' | 'premiere_conversation_ouverte' | 'reglages';

export interface EtatNotifications {
  readonly permission: PermissionNotification;
  /** Nombre de fois où la demande a déjà été présentée. */
  readonly demandesFaites: number;
  /** Vrai une fois qu'un message a été envoyé depuis cet appareil. */
  readonly aEnvoyeUnMessage: boolean;
}

export const ETAT_NOTIFICATIONS_INITIAL: EtatNotifications = {
  permission: 'jamais_demandee',
  demandesFaites: 0,
  aEnvoyeUnMessage: false,
};

/**
 * Faut-il présenter la demande maintenant ?
 *
 * Une seule demande automatique, jamais deux. Le système n'affiche de toute
 * façon sa boîte de dialogue qu'une fois ; redemander ne ferait qu'ouvrir les
 * réglages sans que l'utilisateur l'ait souhaité.
 */
export function doitDemander(etat: EtatNotifications, moment: MomentDemande): boolean {
  // Depuis les réglages, c'est l'utilisateur qui demande : on ne discute pas.
  if (moment === 'reglages') {
    return etat.permission !== 'accordee';
  }

  if (etat.permission !== 'jamais_demandee' || etat.demandesFaites > 0) {
    return false;
  }

  // Ouvrir une conversation ne suffit pas : on peut lire sans jamais écrire, et
  // quelqu'un qui n'a pas encore participé n'a pas de raison d'être notifié.
  return moment === 'premier_message_envoye' && etat.aEnvoyeUnMessage;
}

/**
 * Le jeton a-t-il changé ?
 *
 * Le système renouvelle les jetons sans prévenir — réinstallation, restauration
 * d'une sauvegarde, mise à jour du système. Sans cette comparaison à chaque
 * démarrage, l'appareil garderait un jeton mort et cesserait silencieusement de
 * recevoir quoi que ce soit.
 */
export function jetonAChange(connu: string | null, obtenu: string | null): boolean {
  return connu !== obtenu;
}

/**
 * L'application peut-elle fonctionner sans la permission ?
 *
 * Oui, entièrement, et c'est une exigence : le refus ne doit bloquer aucune
 * fonctionnalité (#57). Cette fonction existe pour que l'interface puisse le
 * dire plutôt que de laisser l'utilisateur le découvrir.
 */
export function notificationsActives(etat: EtatNotifications): boolean {
  return etat.permission === 'accordee';
}
