import {
  formatConversationTimestamp,
  initialsOf,
  matchesSearch,
  type ConversationView,
  type Locale,
  type MessageKind,
  type SyncStatus,
} from '@kola/core';

/**
 * Construction des lignes de la liste des conversations (#29).
 *
 * Toute la logique d'affichage est ici, en fonctions pures : le composant se
 * contente de rendre le résultat. C'est ce qui permet de vérifier le
 * comportement sans émulateur — le tri, la troncature, la sourdine et le
 * libellé du dernier message sont exactement ce qui se casse en silence.
 */

export interface ProfileSummary {
  readonly id: string;
  readonly displayName: string | null;
  readonly username: string | null;
  readonly avatarUrl: string | null;
}

export interface ConversationRow {
  readonly id: string;
  readonly title: string;
  readonly preview: string;
  readonly timestamp: string;
  readonly unreadCount: number;
  readonly isMuted: boolean;
  readonly isPinned: boolean;
  readonly avatarUrl: string | null;
  readonly initials: string;
  /** État du dernier message, seulement s'il vient de nous. */
  readonly ownMessageStatus: SyncStatus | null;
}

export interface BuildRowsInput {
  readonly conversations: readonly ConversationView[];
  readonly profiles: ReadonlyMap<string, ProfileSummary>;
  readonly currentUserId: string;
  readonly now: number;
  readonly locale?: Locale | undefined;
  readonly search?: string | undefined;
  /** État de synchronisation du dernier message, par conversation. */
  readonly ownStatuses?: ReadonlyMap<string, SyncStatus> | undefined;
}

/** Libellé de repli quand un profil n'a ni nom ni pseudo. */
const UNKNOWN_FR = 'Sans nom';
const UNKNOWN_EN = 'Unnamed';

function displayNameOf(profile: ProfileSummary | undefined, locale: Locale): string {
  const name = profile?.displayName?.trim();
  if (name) {
    return name;
  }
  const username = profile?.username?.trim();
  if (username) {
    return `@${username}`;
  }
  // Cas réel : un compte créé par OTP SMS n'a pas encore de nom (#22).
  // Afficher « null » serait pire que tout.
  return locale === 'en' ? UNKNOWN_EN : UNKNOWN_FR;
}

/** Libellé d'un message non textuel, à la place de l'aperçu. */
function mediaLabel(kind: MessageKind, locale: Locale): string | null {
  const en = locale === 'en';
  switch (kind) {
    case 'image':
      return en ? 'Photo' : 'Photo';
    case 'video':
      return en ? 'Video' : 'Vidéo';
    case 'audio':
      return en ? 'Voice message' : 'Message vocal';
    case 'file':
      return en ? 'Document' : 'Document';
    default:
      return null;
  }
}

/**
 * Aperçu d'un message supprimé.
 *
 * Sans lui, la ligne afficherait un aperçu vide et la conversation paraîtrait
 * n'avoir jamais rien contenu, alors qu'elle porte un horodatage.
 */
function deletedLabel(conversation: ConversationView, locale: Locale): string {
  if (conversation.lastMessageKind === 'system') {
    return '';
  }
  return locale === 'en' ? 'Message deleted' : 'Message supprimé';
}

export function buildConversationRows(input: BuildRowsInput): readonly ConversationRow[] {
  const locale = input.locale ?? 'fr';
  const search = input.search ?? '';

  const rows: ConversationRow[] = [];

  for (const conversation of input.conversations) {
    // Une conversation directe n'a pas de titre : il faut le déduire de l'autre
    // participant.
    let title: string;
    let avatarUrl: string | null;

    if (conversation.type === 'dm') {
      const other = otherParticipant(conversation, input.profiles, input.currentUserId);
      title = displayNameOf(other, locale);
      avatarUrl = other?.avatarUrl ?? null;
    } else {
      title = conversation.title?.trim() ?? (locale === 'en' ? 'Group' : 'Groupe');
      avatarUrl = conversation.avatarUrl;
    }

    // La recherche porte sur le titre affiché, pas sur le champ brut : chercher
    // le nom d'un contact doit trouver la conversation directe correspondante.
    if (!matchesSearch(title, search)) {
      continue;
    }

    rows.push({
      id: conversation.id,
      title,
      preview: buildPreview(conversation, input, locale),
      timestamp:
        conversation.lastMessageAt === null
          ? ''
          : formatConversationTimestamp(conversation.lastMessageAt, input.now, locale),
      // Une conversation en sourdine garde son compte : l'utilisateur veut
      // savoir combien il a manqué, il veut juste ne pas être dérangé.
      unreadCount: conversation.unreadCount,
      isMuted: isMuted(conversation, input.now),
      isPinned: conversation.pinnedAt !== null,
      avatarUrl,
      initials: initialsOf(title),
      ownMessageStatus: input.ownStatuses?.get(conversation.id) ?? null,
    });
  }

  return rows;
}

function otherParticipant(
  conversation: ConversationView,
  profiles: ReadonlyMap<string, ProfileSummary>,
  currentUserId: string,
): ProfileSummary | undefined {
  // Le dernier expéditeur suffit dans la plupart des cas et évite de charger la
  // table des membres pour chaque ligne de la liste.
  if (
    conversation.lastMessageSenderId !== null &&
    conversation.lastMessageSenderId !== currentUserId
  ) {
    return profiles.get(conversation.lastMessageSenderId);
  }

  for (const profile of profiles.values()) {
    if (profile.id !== currentUserId) {
      return profile;
    }
  }
  return undefined;
}

function buildPreview(
  conversation: ConversationView,
  input: BuildRowsInput,
  locale: Locale,
): string {
  if (conversation.lastMessageAt === null) {
    // Conversation sans aucun message : elle existe dans la liste, sans aperçu.
    return '';
  }

  // Un message média n'a pas de corps : c'est son type qui donne le libellé.
  const media =
    conversation.lastMessageKind === null ? null : mediaLabel(conversation.lastMessageKind, locale);

  const text = conversation.lastMessagePreview?.trim() ?? '';
  const body = text !== '' ? text : (media ?? deletedLabel(conversation, locale));

  // Dans un groupe, savoir qui a parlé compte autant que ce qui a été dit.
  if (conversation.type !== 'dm' && conversation.lastMessageSenderId !== null) {
    if (conversation.lastMessageSenderId === input.currentUserId) {
      const you = locale === 'en' ? 'You' : 'Vous';
      return `${you} : ${body}`;
    }
    const sender = input.profiles.get(conversation.lastMessageSenderId);
    const name = displayNameOf(sender, locale);
    return `${name} : ${body}`;
  }

  return body;
}

/** Une sourdine expirée n'en est plus une. */
export function isMuted(conversation: ConversationView, now: number): boolean {
  return conversation.mutedUntil !== null && conversation.mutedUntil > now;
}

/**
 * Total des non-lus, pour le badge de l'application.
 *
 * Les conversations en sourdine en sont exclues : le badge sert à décider s'il
 * faut ouvrir l'application, et une conversation qu'on a fait taire ne doit pas
 * peser sur cette décision.
 */
export function totalUnread(conversations: readonly ConversationView[], now: number): number {
  return conversations.reduce(
    (total, conversation) =>
      isMuted(conversation, now) ? total : total + conversation.unreadCount,
    0,
  );
}
