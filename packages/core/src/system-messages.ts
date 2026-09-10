/**
 * Messages système — contenu structuré, traduit à l'affichage (#41).
 *
 * Le corps d'un message système est du JSON typé, jamais une phrase :
 *
 *     {"type":"member_added","target":"…"}
 *
 * et non « Amina a ajouté Kodjo ». La différence est irréversible. Une phrase
 * figée en base reste dans la langue où elle a été écrite, chez tout le monde,
 * pour toujours : ajouter l'anglais ou l'éwé (#63) ne rattraperait aucun des
 * messages déjà envoyés. Le serveur écrit donc une intention, et chaque
 * appareil la rend dans sa propre langue.
 *
 * Corollaire moins évident : ce module doit accepter un `type` qu'il ne connaît
 * pas. Un serveur plus récent que l'application en émettra, et une version
 * installée il y a six mois sur un téléphone jamais mis à jour doit continuer de
 * fonctionner — pas afficher du JSON brut ni planter.
 */

export type SystemMessageBody =
  | { readonly type: 'group_created'; readonly title: string }
  | { readonly type: 'member_added'; readonly target: string }
  | { readonly type: 'member_removed'; readonly target: string }
  | { readonly type: 'member_left' }
  | { readonly type: 'title_changed'; readonly title: string }
  | { readonly type: 'avatar_changed' }
  | { readonly type: 'role_changed'; readonly target: string; readonly role: string }
  /** Type émis par un serveur plus récent que cette version de l'application. */
  | { readonly type: 'unknown' };

const UNKNOWN: SystemMessageBody = { type: 'unknown' };

/**
 * Lit le corps d'un message système.
 *
 * Ne lève jamais. Un corps illisible n'est pas une raison de faire tomber
 * l'écran de conversation : il vaut mieux une ligne discrète qu'un fil vide.
 */
export function parseSystemMessage(body: string | null): SystemMessageBody {
  if (body === null || body === '') {
    return UNKNOWN;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return UNKNOWN;
  }

  if (typeof parsed !== 'object' || parsed === null) {
    return UNKNOWN;
  }

  const record = parsed as Record<string, unknown>;
  const type = record['type'];
  const target = typeof record['target'] === 'string' ? record['target'] : null;
  const title = typeof record['title'] === 'string' ? record['title'] : null;

  switch (type) {
    case 'group_created':
      return { type, title: title ?? '' };
    case 'title_changed':
      return { type, title: title ?? '' };
    case 'member_added':
    case 'member_removed':
      // Sans cible, l'annonce ne veut rien dire : mieux vaut la rendre
      // discrètement générique que d'afficher « a ajouté undefined ».
      return target === null ? UNKNOWN : { type, target };
    case 'member_left':
    case 'avatar_changed':
      return { type };
    case 'role_changed':
      return target === null
        ? UNKNOWN
        : { type, target, role: typeof record['role'] === 'string' ? record['role'] : 'member' };
    default:
      return UNKNOWN;
  }
}

/** Comment nommer quelqu'un dans une annonce, quand on ne le connaît pas encore. */
export type NameResolver = (userId: string | null) => string;

export interface SystemMessageStrings {
  readonly groupCreated: (actor: string, title: string) => string;
  readonly memberAdded: (actor: string, target: string) => string;
  readonly memberRemoved: (actor: string, target: string) => string;
  readonly memberLeft: (actor: string) => string;
  readonly titleChanged: (actor: string, title: string) => string;
  readonly avatarChanged: (actor: string) => string;
  readonly roleChanged: (actor: string, target: string, role: string) => string;
  readonly unknown: () => string;
}

/**
 * Rend un message système en une phrase.
 *
 * Les libellés sont injectés plutôt qu'écrits ici : c'est ce qui permettra à
 * #63 de brancher l'anglais, puis l'éwé et le kabiyè, sans toucher à cette
 * fonction ni au contenu déjà en base.
 */
export function formatSystemMessage(
  body: SystemMessageBody,
  actorId: string | null,
  resolveName: NameResolver,
  strings: SystemMessageStrings,
): string {
  const actor = resolveName(actorId);

  switch (body.type) {
    case 'group_created':
      return strings.groupCreated(actor, body.title);
    case 'member_added':
      return strings.memberAdded(actor, resolveName(body.target));
    case 'member_removed':
      return strings.memberRemoved(actor, resolveName(body.target));
    case 'member_left':
      return strings.memberLeft(actor);
    case 'title_changed':
      return strings.titleChanged(actor, body.title);
    case 'avatar_changed':
      return strings.avatarChanged(actor);
    case 'role_changed':
      return strings.roleChanged(actor, resolveName(body.target), body.role);
    default:
      return strings.unknown();
  }
}

/**
 * Libellés français.
 *
 * Provisoirement ici : #63 les déplacera dans les fichiers de traduction. Ce qui
 * compte est qu'ils vivent DANS L'APPLICATION et non en base — c'est cela qui
 * rend le changement de langue possible après coup.
 */
export const SYSTEM_MESSAGE_FR: SystemMessageStrings = {
  groupCreated: (actor, title) => `${actor} a créé le groupe « ${title} »`,
  memberAdded: (actor, target) => `${actor} a ajouté ${target}`,
  memberRemoved: (actor, target) => `${actor} a retiré ${target}`,
  memberLeft: (actor) => `${actor} a quitté le groupe`,
  titleChanged: (actor, title) => `${actor} a renommé le groupe en « ${title} »`,
  avatarChanged: (actor) => `${actor} a changé la photo du groupe`,
  roleChanged: (actor, target, role) =>
    role === 'admin'
      ? `${actor} a nommé ${target} administrateur`
      : `${actor} a retiré les droits d'administrateur de ${target}`,
  unknown: () => 'Mise à jour du groupe',
};
