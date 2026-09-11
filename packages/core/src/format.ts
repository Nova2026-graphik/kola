import type { Locale } from './types';

/**
 * Formatage pour la liste des conversations et l'écran de conversation.
 *
 * Écrit à la main plutôt qu'emprunté à une bibliothèque de dates. `date-fns`
 * avec ses locales, ou `dayjs` avec ses greffons, coûtent plusieurs dizaines de
 * kilooctets pour ce dont nous avons besoin ici : quatre cas d'horodatage
 * relatif. L'ADR-0006 dit que certaines bibliothèques confortables seront
 * refusées — celle-ci en fait partie.
 *
 * Toutes les fonctions de ce fichier sont pures et prennent l'instant de
 * référence en paramètre : elles ne lisent jamais l'horloge elles-mêmes, ce qui
 * les rend testables sans figer le temps.
 */

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

interface DateLabels {
  readonly yesterday: string;
  readonly weekdays: readonly string[];
}

const LABELS: Record<'fr' | 'en', DateLabels> = {
  fr: {
    yesterday: 'Hier',
    weekdays: ['dimanche', 'lundi', 'mardi', 'mercredi', 'jeudi', 'vendredi', 'samedi'],
  },
  en: {
    yesterday: 'Yesterday',
    weekdays: ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'],
  },
};

function labelsFor(locale: Locale): DateLabels {
  // L'éwé et le kabiyè retombent sur le français tant qu'ils ne sont pas
  // traduits (#63), plutôt que d'afficher de l'anglais par accident.
  return locale === 'en' ? LABELS.en : LABELS.fr;
}

/** Minuit local du jour contenant `timestamp`. */
function startOfDay(timestamp: number): number {
  const date = new Date(timestamp);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

function twoDigits(value: number): string {
  return value.toString().padStart(2, '0');
}

/**
 * Horodatage de la liste des conversations.
 *
 * Quatre cas, du plus fréquent au plus rare : aujourd'hui l'heure, hier le mot
 * « hier », cette semaine le jour, au-delà la date. C'est ce que l'utilisateur
 * a besoin de savoir, et rien de plus.
 */
export function formatConversationTimestamp(
  timestamp: number,
  now: number,
  locale: Locale = 'fr',
): string {
  const labels = labelsFor(locale);
  const today = startOfDay(now);
  const date = new Date(timestamp);

  if (timestamp >= today) {
    return `${twoDigits(date.getHours())}:${twoDigits(date.getMinutes())}`;
  }

  if (timestamp >= today - DAY) {
    return labels.yesterday;
  }

  if (timestamp >= today - 6 * DAY) {
    return labels.weekdays[date.getDay()] ?? '';
  }

  const year = date.getFullYear() === new Date(now).getFullYear() ? '' : `/${date.getFullYear()}`;
  return `${twoDigits(date.getDate())}/${twoDigits(date.getMonth() + 1)}${year}`;
}

/** Séparateur de date dans une conversation. */
export function formatDateSeparator(timestamp: number, now: number, locale: Locale = 'fr'): string {
  const labels = labelsFor(locale);
  const today = startOfDay(now);

  if (timestamp >= today) {
    return locale === 'en' ? 'Today' : "Aujourd'hui";
  }
  if (timestamp >= today - DAY) {
    return labels.yesterday;
  }

  const date = new Date(timestamp);
  const weekday = labels.weekdays[date.getDay()] ?? '';
  const day = date.getDate();
  const month = twoDigits(date.getMonth() + 1);

  if (timestamp >= today - 6 * DAY) {
    return weekday;
  }
  return `${weekday} ${String(day)}/${month}`;
}

/** Durée d'un message vocal ou d'une vidéo, en `m:ss`. */
export function formatDuration(durationMs: number): string {
  const totalSeconds = Math.max(0, Math.round(durationMs / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes)}:${twoDigits(seconds)}`;
}

/**
 * Dernière connaissance de la présence, pour l'en-tête de conversation.
 *
 * Retourne `null` plutôt qu'une valeur bidon quand l'information manque :
 * l'appelant décide alors de ne rien afficher, ce qui vaut mieux qu'un
 * « vu il y a 56 ans ».
 */
export function formatLastSeen(
  lastSeenAt: number | null,
  now: number,
  locale: Locale = 'fr',
): string | null {
  if (lastSeenAt === null) {
    return null;
  }

  const elapsed = now - lastSeenAt;
  const en = locale === 'en';

  if (elapsed < 2 * MINUTE) {
    return en ? 'online' : 'en ligne';
  }
  if (elapsed < HOUR) {
    const minutes = Math.floor(elapsed / MINUTE);
    return en ? `last seen ${String(minutes)} min ago` : `vu il y a ${String(minutes)} min`;
  }
  if (elapsed < DAY) {
    const hours = Math.floor(elapsed / HOUR);
    return en ? `last seen ${String(hours)} h ago` : `vu il y a ${String(hours)} h`;
  }

  const prefix = en ? 'last seen' : 'vu le';
  return `${prefix} ${formatConversationTimestamp(lastSeenAt, now, locale)}`;
}

/**
 * Initiales pour l'avatar de repli.
 *
 * Beaucoup de noms de la région comptent plusieurs éléments (« Komlan Kwadzo
 * Mawuli ») : on prend le premier et le dernier, jamais les trois.
 */
export function initialsOf(displayName: string | null | undefined): string {
  const trimmed = (displayName ?? '').trim();
  if (trimmed === '') {
    return '?';
  }

  const parts = trimmed.split(/\s+/u).filter((part) => part.length > 0);
  const first = parts[0]?.[0] ?? '';
  const last = parts.length > 1 ? (parts[parts.length - 1]?.[0] ?? '') : '';

  return (first + last).toUpperCase();
}

/**
 * Normalise pour la recherche : sans accent, sans casse.
 *
 * Chercher « ete » doit trouver « été ». La décomposition Unicode sépare les
 * lettres de leurs diacritiques, qu'on retire ensuite.
 */
export function normalizeForSearch(value: string): string {
  return value.normalize('NFD').replace(/[̀-ͯ]/gu, '').toLocaleLowerCase();
}

export function matchesSearch(haystack: string | null | undefined, needle: string): boolean {
  const query = normalizeForSearch(needle).trim();
  if (query === '') {
    return true;
  }
  return normalizeForSearch(haystack ?? '').includes(query);
}
