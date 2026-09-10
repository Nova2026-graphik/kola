import { describe, expect, it } from 'vitest';

import type { MessageView } from '@kola/core';

import {
  buildFeed,
  canGroup,
  GROUPING_WINDOW_MS,
  initialScrollIndex,
  nextPageCursor,
  type FeedItem,
} from './grouping';

/**
 * L'écran de conversation affiche une liste INVERSÉE : l'indice 0 est en bas,
 * donc le message le plus récent. C'est contre-intuitif, et c'est exactement
 * pourquoi ces tests existent.
 */

const NOW = new Date(2026, 8, 10, 14, 30, 0).getTime();
const CONV = 'conv-1';
const ME = 'me';
const OTHER = 'other';

let counter = 0;

function message(overrides: Partial<MessageView> = {}): MessageView {
  counter += 1;
  return {
    clientId: `m${String(counter)}`,
    id: `srv-${String(counter)}`,
    conversationId: CONV,
    senderId: OTHER,
    seq: counter,
    kind: 'text',
    body: `message ${String(counter)}`,
    replyToId: null,
    editedAt: null,
    deletedAt: null,
    createdAt: NOW,
    syncStatus: 'sent',
    ...overrides,
  };
}

function messagesOf(items: readonly FeedItem[]): string[] {
  return items.filter((i) => i.type === 'message').map((i) => i.message.body ?? '');
}

describe('groupement des messages consécutifs', () => {
  it('groupe deux messages proches du même auteur', () => {
    const older = message({ createdAt: NOW - 60_000 });
    const newer = message({ createdAt: NOW, senderId: OTHER });
    expect(canGroup(older, newer)).toBe(true);
  });

  it('ne groupe pas deux auteurs différents', () => {
    const older = message({ createdAt: NOW - 60_000, senderId: ME });
    const newer = message({ createdAt: NOW, senderId: OTHER });
    expect(canGroup(older, newer)).toBe(false);
  });

  it('ne groupe pas au-delà de la fenêtre', () => {
    const older = message({ createdAt: NOW - GROUPING_WINDOW_MS - 1 });
    const newer = message({ createdAt: NOW });
    expect(canGroup(older, newer)).toBe(false);
  });

  it('ne groupe pas de part et d’autre de minuit', () => {
    // Deux messages à cinq minutes d'intervalle mais un jour différent : un
    // séparateur de date les sépare, les grouper serait absurde.
    const older = message({ createdAt: new Date(2026, 8, 9, 23, 58).getTime() });
    const newer = message({ createdAt: new Date(2026, 8, 10, 0, 1).getTime() });
    expect(canGroup(older, newer)).toBe(false);
  });

  it('ne groupe jamais un message système', () => {
    // Ils s'affichent centrés, hors du flux des bulles.
    const older = message({ createdAt: NOW - 1000, kind: 'system' });
    const newer = message({ createdAt: NOW });
    expect(canGroup(older, newer)).toBe(false);
    expect(canGroup(newer, message({ createdAt: NOW, kind: 'system' }))).toBe(false);
  });

  it('ne groupe rien aux bords', () => {
    expect(canGroup(undefined, message())).toBe(false);
    expect(canGroup(message(), undefined)).toBe(false);
  });
});

describe('construction du flux', () => {
  it('conserve l’ordre du plus récent au plus ancien', () => {
    const feed = buildFeed({
      messages: [
        message({ body: 'récent', createdAt: NOW }),
        message({ body: 'ancien', createdAt: NOW - 60_000 }),
      ],
      now: NOW,
    });

    // Indice 0 = bas de l'écran = le plus récent.
    expect(messagesOf(feed)).toEqual(['récent', 'ancien']);
  });

  it('insère un séparateur de date au changement de jour', () => {
    const feed = buildFeed({
      messages: [
        message({ body: 'aujourd’hui', createdAt: NOW }),
        message({ body: 'hier', createdAt: NOW - 24 * 60 * 60_000 }),
      ],
      now: NOW,
    });

    const dates = feed.filter((i) => i.type === 'date').map((i) => i.label);
    expect(dates).toEqual(["Aujourd'hui", 'Hier']);
  });

  it('place le séparateur APRÈS les messages du jour qu’il annonce', () => {
    // Conséquence de la liste inversée : le séparateur s'affiche au-dessus des
    // messages, donc il vient après eux dans le tableau.
    const feed = buildFeed({
      messages: [message({ body: 'seul', createdAt: NOW })],
      now: NOW,
    });

    expect(feed[0]?.type).toBe('message');
    expect(feed[1]?.type).toBe('date');
  });

  it('termine toujours par un séparateur, au début de l’historique', () => {
    const feed = buildFeed({
      messages: [message({ createdAt: NOW }), message({ createdAt: NOW - 1000 })],
      now: NOW,
    });

    expect(feed[feed.length - 1]?.type).toBe('date');
  });

  it('marque le premier et le dernier d’une salve', () => {
    const feed = buildFeed({
      messages: [
        message({ body: 'c', createdAt: NOW, senderId: OTHER }),
        message({ body: 'b', createdAt: NOW - 30_000, senderId: OTHER }),
        message({ body: 'a', createdAt: NOW - 60_000, senderId: OTHER }),
      ],
      now: NOW,
    });

    const items = feed.filter((i) => i.type === 'message');
    // Le plus récent (indice 0) ferme la salve : c'est lui qui porte l'heure.
    expect(items[0]?.isLastOfGroup).toBe(true);
    expect(items[0]?.groupedWithPrevious).toBe(true);
    // Le plus ancien l'ouvre : c'est lui qui porte l'avatar et le nom.
    expect(items[2]?.groupedWithPrevious).toBe(false);
    expect(items[2]?.isLastOfGroup).toBe(false);
  });

  it('gère un flux vide', () => {
    expect(buildFeed({ messages: [], now: NOW })).toEqual([]);
  });

  it('écarte les messages masqués localement', () => {
    const hidden = { ...message({ body: 'masqué' }), hiddenLocally: true } as MessageView;
    const feed = buildFeed({
      messages: [message({ body: 'visible', createdAt: NOW }), hidden],
      now: NOW,
    });

    expect(messagesOf(feed)).toEqual(['visible']);
  });
});

describe('marqueur de nouveaux messages', () => {
  it('se place à la frontière du dernier message lu', () => {
    const feed = buildFeed({
      messages: [
        message({ body: 'non lu 2', seq: 12, createdAt: NOW }),
        message({ body: 'non lu 1', seq: 11, createdAt: NOW - 1000 }),
        message({ body: 'lu', seq: 10, createdAt: NOW - 2000 }),
      ],
      now: NOW,
      lastReadSeq: 10,
      currentUserId: ME,
    });

    const markerIndex = feed.findIndex((i) => i.type === 'unread');
    expect(markerIndex).toBeGreaterThan(-1);

    const marker = feed[markerIndex];
    expect(marker?.type === 'unread' && marker.count).toBe(2);

    // Il s'affiche au-dessus du premier non lu, donc juste après lui dans le
    // tableau inversé.
    const before = feed[markerIndex - 1];
    expect(before?.type === 'message' && before.message.body).toBe('non lu 1');
  });

  it('ne place rien quand tout est lu', () => {
    const feed = buildFeed({
      messages: [message({ seq: 5, createdAt: NOW })],
      now: NOW,
      lastReadSeq: 5,
    });

    expect(feed.some((i) => i.type === 'unread')).toBe(false);
  });

  it('ne compte pas ses propres messages comme non lus', () => {
    const feed = buildFeed({
      messages: [
        message({ body: 'le mien', seq: 12, senderId: ME, createdAt: NOW }),
        message({ body: 'lu', seq: 10, createdAt: NOW - 2000 }),
      ],
      now: NOW,
      lastReadSeq: 10,
      currentUserId: ME,
    });

    // Un message qu'on vient d'envoyer n'est pas « non lu ».
    expect(feed.some((i) => i.type === 'unread')).toBe(false);
  });

  it('ne place rien sans information de lecture', () => {
    const feed = buildFeed({
      messages: [message({ seq: 12, createdAt: NOW })],
      now: NOW,
    });

    expect(feed.some((i) => i.type === 'unread')).toBe(false);
  });
});

describe('pagination', () => {
  it('prend le seq du message le plus ancien comme curseur', () => {
    const cursor = nextPageCursor([
      message({ seq: 12 }),
      message({ seq: 11 }),
      message({ seq: 10 }),
    ]);
    expect(cursor).toBe(10);
  });

  it('ignore les messages en attente, qui n’ont pas de seq', () => {
    // Sinon la pagination repartirait du début à chaque envoi hors ligne.
    const cursor = nextPageCursor([
      message({ seq: null, syncStatus: 'pending' }),
      message({ seq: 7 }),
      message({ seq: null, syncStatus: 'pending' }),
    ]);
    expect(cursor).toBe(7);
  });

  it('ne rend aucun curseur quand rien n’est encore synchronisé', () => {
    const cursor = nextPageCursor([message({ seq: null }), message({ seq: null })]);
    expect(cursor).toBeNull();
  });

  it('ne rend aucun curseur sur un flux vide', () => {
    expect(nextPageCursor([])).toBeNull();
  });
});

describe('position initiale', () => {
  it('ouvre en bas quand tout est lu', () => {
    const feed = buildFeed({ messages: [message({ createdAt: NOW })], now: NOW });
    expect(initialScrollIndex(feed)).toBe(0);
  });

  it('ouvre sur le premier non lu', () => {
    const feed = buildFeed({
      messages: [
        message({ seq: 12, createdAt: NOW }),
        message({ seq: 11, createdAt: NOW - 1000 }),
        message({ seq: 10, createdAt: NOW - 2000 }),
      ],
      now: NOW,
      lastReadSeq: 10,
      currentUserId: ME,
    });

    // Reprendre la lecture où on l'a laissée, plutôt que de faire défiler à
    // chaque ouverture.
    const index = initialScrollIndex(feed);
    expect(index).toBeGreaterThan(0);
    expect(feed[index]?.type).toBe('unread');
  });
});
