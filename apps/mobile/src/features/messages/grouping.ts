import { formatDateSeparator, type Locale, type MessageView } from '@kola/core';

/**
 * Mise en forme du flux de messages (#30).
 *
 * L'écran de conversation affiche une liste **inversée** : l'élément d'indice 0
 * est en bas de l'écran, c'est-à-dire le message le plus récent. C'est la seule
 * façon d'obtenir un ancrage correct en bas sans calculs de position fragiles,
 * mais cela retourne l'intuition — d'où l'attention portée ici, et les tests.
 */

export interface MessageItem {
  readonly type: 'message';
  readonly key: string;
  readonly message: MessageView;
  /** Colle à la bulle précédente du même auteur : pas d'avatar ni de nom. */
  readonly groupedWithPrevious: boolean;
  /** Dernière bulle d'une salve : c'est elle qui porte l'horodatage. */
  readonly isLastOfGroup: boolean;
}

export interface DateSeparatorItem {
  readonly type: 'date';
  readonly key: string;
  readonly label: string;
  readonly timestamp: number;
}

export interface UnreadMarkerItem {
  readonly type: 'unread';
  readonly key: string;
  readonly count: number;
}

export type FeedItem = MessageItem | DateSeparatorItem | UnreadMarkerItem;

/** Au-delà, deux messages du même auteur ne forment plus une salve. */
export const GROUPING_WINDOW_MS = 5 * 60_000;

export interface BuildFeedInput {
  /** Messages triés du plus récent au plus ancien, comme les rend le repository. */
  readonly messages: readonly MessageView[];
  readonly now: number;
  readonly locale?: Locale | undefined;
  /** Dernier seq lu : sert à placer le marqueur « nouveaux messages ». */
  readonly lastReadSeq?: number | undefined;
  readonly currentUserId?: string | undefined;
}

function sameDay(a: number, b: number): boolean {
  const first = new Date(a);
  const second = new Date(b);
  return (
    first.getFullYear() === second.getFullYear() &&
    first.getMonth() === second.getMonth() &&
    first.getDate() === second.getDate()
  );
}

/**
 * Construit le flux affichable, dans l'ordre de la liste inversée.
 *
 * Le résultat mélange messages, séparateurs de date et marqueur de non-lus.
 * Comme la liste est inversée, un séparateur de date se place **après** les
 * messages du jour qu'il annonce.
 */
export function buildFeed(input: BuildFeedInput): readonly FeedItem[] {
  const locale = input.locale ?? 'fr';
  const items: FeedItem[] = [];

  const visible = input.messages.filter((message) => !isHidden(message));
  let unreadMarkerPlaced = false;

  for (let index = 0; index < visible.length; index += 1) {
    const message = visible[index];
    if (!message) {
      continue;
    }

    // « Suivant » dans la liste inversée signifie « plus ancien » dans le temps.
    const older = visible[index + 1];
    const newer = visible[index - 1];

    const groupedWithPrevious = canGroup(older, message);
    const isLastOfGroup = !canGroup(message, newer);

    items.push({
      type: 'message',
      key: message.clientId,
      message,
      groupedWithPrevious,
      isLastOfGroup,
    });

    // Le marqueur se place juste sous le premier message non lu, donc après lui
    // dans une liste inversée.
    if (
      !unreadMarkerPlaced &&
      input.lastReadSeq !== undefined &&
      shouldMarkUnreadBefore(message, older, input)
    ) {
      const count = countUnread(visible, input.lastReadSeq, input.currentUserId);
      if (count > 0) {
        items.push({ type: 'unread', key: `unread-${message.clientId}`, count });
        unreadMarkerPlaced = true;
      }
    }

    // Un séparateur s'insère quand le message plus ancien tombe un autre jour —
    // ou quand il n'y en a plus, car on est alors au début de l'historique.
    if (!older || !sameDay(message.createdAt, older.createdAt)) {
      items.push({
        type: 'date',
        key: `date-${String(message.createdAt)}`,
        label: formatDateSeparator(message.createdAt, input.now, locale),
        timestamp: message.createdAt,
      });
    }
  }

  return items;
}

/** Masqué localement (« supprimer pour moi »). */
function isHidden(message: MessageView): boolean {
  return (message as { hiddenLocally?: boolean }).hiddenLocally === true;
}

/**
 * Deux messages forment-ils une salve ?
 *
 * `older` précède `newer` dans le temps. Ils se groupent s'ils ont le même
 * auteur, sont proches dans le temps, et ne sont ni l'un ni l'autre des
 * messages système — ceux-ci s'affichent centrés, hors du flux des bulles.
 */
export function canGroup(older: MessageView | undefined, newer: MessageView | undefined): boolean {
  if (!older || !newer) {
    return false;
  }
  if (older.kind === 'system' || newer.kind === 'system') {
    return false;
  }
  if (older.senderId !== newer.senderId) {
    return false;
  }
  if (!sameDay(older.createdAt, newer.createdAt)) {
    return false;
  }
  return newer.createdAt - older.createdAt <= GROUPING_WINDOW_MS;
}

function shouldMarkUnreadBefore(
  message: MessageView,
  older: MessageView | undefined,
  input: BuildFeedInput,
): boolean {
  const lastReadSeq = input.lastReadSeq ?? 0;

  // Un message sans seq est en attente d'envoi : il vient de nous, il n'est
  // jamais « non lu ».
  if (message.seq === null || message.seq <= lastReadSeq) {
    return false;
  }
  // Le message plus ancien doit, lui, être déjà lu : c'est là que passe la
  // frontière.
  return older === undefined || (older.seq !== null && older.seq <= lastReadSeq);
}

function countUnread(
  messages: readonly MessageView[],
  lastReadSeq: number,
  currentUserId: string | undefined,
): number {
  return messages.filter(
    (message) =>
      message.seq !== null &&
      message.seq > lastReadSeq &&
      // Ses propres messages ne comptent pas comme non lus.
      (currentUserId === undefined || message.senderId !== currentUserId),
  ).length;
}

/**
 * Curseur pour charger la page suivante.
 *
 * Les messages en attente n'ont pas de seq : ils ne peuvent pas servir de
 * curseur, sinon la pagination repartirait du début à chaque envoi hors ligne.
 */
export function nextPageCursor(messages: readonly MessageView[]): number | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const seq = messages[index]?.seq;
    if (seq !== null && seq !== undefined) {
      return seq;
    }
  }
  return null;
}

/**
 * Indice où positionner la vue à l'ouverture.
 *
 * Sur le premier message non lu s'il y en a, sinon en bas. Reprendre la lecture
 * là où on l'a laissée est ce qui distingue une messagerie utilisable d'une
 * messagerie qu'il faut faire défiler à chaque ouverture.
 */
export function initialScrollIndex(items: readonly FeedItem[]): number {
  const markerIndex = items.findIndex((item) => item.type === 'unread');
  return markerIndex === -1 ? 0 : markerIndex;
}
