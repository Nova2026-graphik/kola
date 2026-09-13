import {
  doitDemander,
  jetonAChange,
  type EtatNotifications,
  type MomentDemande,
  type PermissionNotification,
} from '@kola/core';

/**
 * Enregistrement du jeton push (#57).
 *
 * Tout ce qui touche au système est INJECTÉ. Ce fichier ne sait ni demander une
 * permission, ni obtenir un jeton, ni écrire en base — il sait seulement dans
 * quel ordre le faire et quoi ne pas faire.
 *
 * C'est ce qui le rend testable sous Node, et c'est nécessaire : les défauts de
 * ce module ne se voient pas. Un jeton qui n'est pas renouvelé, une permission
 * demandée au mauvais moment, un jeton non effacé à la déconnexion — rien de
 * tout cela ne lève d'exception. Cela se manifeste par des notifications qui
 * n'arrivent pas, ou qui arrivent chez la mauvaise personne.
 */

export interface SystemeNotifications {
  /** L'état actuel de la permission, sans rien demander. */
  readonly lirePermission: () => Promise<PermissionNotification>;
  /** Présente la demande système. Une seule fois dans la vie de l'application. */
  readonly demanderPermission: () => Promise<PermissionNotification>;
  /** Le jeton Expo, ou null si la permission n'est pas accordée. */
  readonly obtenirJeton: () => Promise<string | null>;
}

export interface DepotAppareil {
  readonly lireJetonConnu: (deviceId: string) => Promise<string | null>;
  readonly enregistrer: (jeton: string | null) => Promise<void>;
  readonly effacerJeton: () => Promise<void>;
}

export interface OptionsEnregistrement {
  readonly systeme: SystemeNotifications;
  readonly depot: DepotAppareil;
  readonly deviceId: string;
  readonly etat: EtatNotifications;
  /** Notifié quand l'état change, pour que l'interface le reflète. */
  readonly onEtat?: (etat: EtatNotifications) => void;
}

export interface ResultatEnregistrement {
  readonly etat: EtatNotifications;
  /** Vrai si le serveur a été écrit. Faux quand rien n'avait changé. */
  readonly ecrit: boolean;
  /** Vrai si la demande système a été présentée pendant cet appel. */
  readonly demandee: boolean;
}

/**
 * Synchronise le jeton de cet appareil avec le serveur.
 *
 * À appeler au démarrage, après connexion. Ne demande jamais la permission :
 * c'est `demanderSiJustifie` qui s'en charge, au moment où elle se justifie.
 */
export async function synchroniserJeton(
  options: OptionsEnregistrement,
  /**
   * Permission déjà connue de l'appelant.
   *
   * Quand la demande vient d'aboutir, son résultat est plus sûr qu'une
   * relecture : rien ne garantit que le système reflète immédiatement un
   * changement qu'on vient de provoquer, et une relecture qui renverrait encore
   * l'ancienne valeur ferait silencieusement sauter l'enregistrement du jeton.
   */
  permissionConnue?: PermissionNotification,
): Promise<ResultatEnregistrement> {
  const { systeme, depot, deviceId, etat } = options;

  const permission = permissionConnue ?? (await systeme.lirePermission());
  const suivant: EtatNotifications = { ...etat, permission };
  options.onEtat?.(suivant);

  // Sans permission, il n'y a pas de jeton à obtenir. Mais il peut y en avoir un
  // ANCIEN côté serveur — permission révoquée depuis les réglages du système.
  // Le serveur doit l'apprendre, sinon il enverra indéfiniment vers un jeton
  // mort en croyant notifier quelqu'un.
  const jeton = permission === 'accordee' ? await systeme.obtenirJeton() : null;
  const connu = await depot.lireJetonConnu(deviceId);

  if (!jetonAChange(connu, jeton)) {
    return { etat: suivant, ecrit: false, demandee: false };
  }

  await depot.enregistrer(jeton);
  return { etat: suivant, ecrit: true, demandee: false };
}

/**
 * Demande la permission, si ce moment la justifie.
 *
 * Sur iOS, un refus est quasi définitif — il faut aller le changer dans les
 * réglages du système, ce que presque personne ne fait. Le moment n'est donc
 * pas un détail d'ergonomie : c'est la seule occasion.
 */
export async function demanderSiJustifie(
  options: OptionsEnregistrement,
  moment: MomentDemande,
): Promise<ResultatEnregistrement> {
  const { systeme, etat } = options;

  if (!doitDemander(etat, moment)) {
    return { etat, ecrit: false, demandee: false };
  }

  const permission = await systeme.demanderPermission();
  const suivant: EtatNotifications = {
    ...etat,
    permission,
    demandesFaites: etat.demandesFaites + 1,
  };
  options.onEtat?.(suivant);

  if (permission !== 'accordee') {
    // Refus. Rien d'autre ne change : aucune fonctionnalité n'en dépend (#57).
    return { etat: suivant, ecrit: false, demandee: true };
  }

  const resultat = await synchroniserJeton({ ...options, etat: suivant }, permission);
  return { ...resultat, demandee: true };
}

/**
 * Coupe les notifications pour cet appareil.
 *
 * À la déconnexion. L'ordre compte : on efface côté serveur AVANT d'oublier
 * localement. L'inverse laisserait un jeton actif sur un compte dont on vient
 * de se déconnecter — quelqu'un d'autre se connecte sur ce téléphone et reçoit
 * les notifications du précédent.
 */
export async function couperNotifications(depot: DepotAppareil): Promise<void> {
  await depot.effacerJeton();
}
