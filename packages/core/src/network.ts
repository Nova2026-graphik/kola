/**
 * État de la connexion, du point de vue de l'utilisateur.
 *
 * Le point important est la distinction entre `offline` et `limited`. La
 * détection native indique la connexion à un RÉSEAU, pas l'accès à Internet :
 * un portail captif d'hôtel ou de cybercafé se déclare parfaitement connecté,
 * et une messagerie qui s'y fie affiche « en ligne » pendant que rien ne part.
 * Les deux cas appellent des messages différents, donc deux états distincts.
 */
export type NetworkStatus =
  /** Aucun réseau. Mode avion, ou hors couverture. */
  | 'offline'
  /** Réseau présent, serveur injoignable. Portail captif, DNS cassé, panne. */
  | 'limited'
  /** Une vérification est en cours après un changement d'état. */
  | 'reconnecting'
  /** Réseau et serveur joignables. */
  | 'online';

/** Type de connexion, pour la politique d'économie de données (#49, #56). */
export type ConnectionType = 'wifi' | 'cellular' | 'other' | 'none';

export interface NetworkState {
  readonly status: NetworkStatus;
  readonly connectionType: ConnectionType;
  /**
   * Connexion facturée à la donnée.
   *
   * Piège fréquent : un partage de connexion apparaît souvent comme du Wi-Fi
   * alors qu'il consomme le forfait mobile de quelqu'un. Quand la plateforme
   * expose l'information, elle prime sur le type de connexion.
   */
  readonly isMetered: boolean;
  /** Une passe de synchronisation est en cours. */
  readonly isSyncing: boolean;
  /** Nombre de messages écrits mais pas encore partis. */
  readonly pendingCount: number;
}

export const INITIAL_NETWORK_STATE: NetworkState = {
  status: 'reconnecting',
  connectionType: 'none',
  isMetered: false,
  isSyncing: false,
  pendingCount: 0,
};

/**
 * Faut-il montrer un bandeau, et lequel.
 *
 * Aucun bandeau quand tout va bien : c'est un état normal, il n'a pas besoin
 * d'être commenté. Et jamais de bandeau au premier instant du démarrage, tant
 * que la première vérification n'a pas conclu — sinon l'application clignote
 * « hors ligne » à chaque ouverture.
 */
export type BannerKind = 'none' | 'offline' | 'limited' | 'reconnecting' | 'syncing';

export function bannerFor(state: NetworkState): BannerKind {
  if (state.status === 'offline') {
    return 'offline';
  }
  if (state.status === 'limited') {
    return 'limited';
  }
  if (state.status === 'reconnecting') {
    // Au démarrage, on ne sait pas encore : ne rien dire plutôt que d'alarmer.
    return state.pendingCount > 0 ? 'reconnecting' : 'none';
  }
  return state.isSyncing && state.pendingCount > 0 ? 'syncing' : 'none';
}

/**
 * L'application reste-t-elle utilisable en écriture ?
 *
 * **Toujours vrai.** Cette fonction existe pour que la réponse soit écrite
 * quelque part et testée, pas pour être appelée : le composeur ne se désactive
 * jamais, en aucune circonstance. Un message rédigé hors ligne est mis en file
 * et part au retour du réseau (ADR-0002). Désactiver la saisie reviendrait à
 * renier la promesse centrale du produit.
 */
export function canCompose(_state: NetworkState): true {
  return true;
}
