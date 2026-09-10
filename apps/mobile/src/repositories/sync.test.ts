import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';

import type { RemoteConversation, RemoteMessage } from '@kola/core';

import { conversations, messages, syncState } from '../db/schema';
import { createClock, createTestDatabase } from '../db/testing';

import { conversationChanges, messageChanges } from './changes';
import type { LocalDatabase } from './database';
import { applyConversations, applyMessagePage, readCursor, resetCursor } from './sync';

/**
 * Écritures de la synchronisation entrante.
 *
 * Ce fichier vérifie ce que le moteur ne peut pas voir : ce que la
 * synchronisation doit ÉCRASER, et surtout ce qu'elle ne doit jamais écraser.
 * Les décisions purement locales — un message masqué pour soi, un accusé de
 * lecture pas encore remonté — n'ont pas d'équivalent côté serveur, et une
 * passe qui les efface produit un bug que l'utilisateur voit tout de suite mais
 * qu'aucun test d'intégration ne rattrape.
 */

const CONV = 'conv-1';

function remoteMessage(overrides: Partial<RemoteMessage> = {}): RemoteMessage {
  return {
    id: 'srv-1',
    clientId: 'cli-1',
    conversationId: CONV,
    senderId: 'someone',
    seq: 1,
    changeSeq: 1,
    kind: 'text',
    body: 'bonjour',
    replyToId: null,
    editedAt: null,
    deletedAt: null,
    createdAt: 1_767_225_600_000,
    ...overrides,
  };
}

function remoteConversation(overrides: Partial<RemoteConversation> = {}): RemoteConversation {
  return {
    id: CONV,
    type: 'group',
    title: 'Tontine du quartier',
    avatarUrl: null,
    ownerId: null,
    communityId: null,
    lastMessageAt: 1_767_225_600_000,
    lastMessagePreview: 'bonjour',
    lastMessageSenderId: 'someone',
    lastMessageKind: 'text',
    lastSeq: 1,
    lastChangeSeq: 1,
    lastReadSeq: 0,
    mutedUntil: null,
    pinnedAt: null,
    archivedAt: null,
    createdAt: 1_767_225_600_000,
    description: null,
    restricted: false,
    myRole: 'member',
    ...overrides,
  };
}

describe('écritures de la synchronisation entrante', () => {
  let db: LocalDatabase;
  let clock: ReturnType<typeof createClock>;

  beforeEach(() => {
    const test = createTestDatabase();
    db = test.db;
    clock = createClock();
    return () => {
      test.close();
    };
  });

  it('avance le curseur au plus grand change_seq de la page, pas à sa taille', () => {
    // Un message modifié creuse un trou dans la suite : compter les lignes
    // ferait redemander éternellement les mêmes.
    applyMessagePage(
      db,
      CONV,
      [
        remoteMessage({ id: 'srv-a', clientId: 'a', seq: 1, changeSeq: 4 }),
        remoteMessage({ id: 'srv-b', clientId: 'b', seq: 2, changeSeq: 9 }),
      ],
      clock.now(),
    );

    expect(readCursor(db, CONV).lastChangeSeq).toBe(9);
  });

  it('écrit le message sur sa propre ligne quand il revient du serveur', () => {
    // Le message qu'on vient d'envoyer soi-même revient par la synchronisation.
    // Sans clé sur le clientId, il apparaîtrait une seconde fois.
    db.insert(messages)
      .values({
        clientId: 'cli-1',
        conversationId: CONV,
        body: 'bonjour',
        syncStatus: 'pending',
        createdAt: clock.now(),
      })
      .run();

    applyMessagePage(db, CONV, [remoteMessage()], clock.now());

    const rows = db.select().from(messages).all();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.id).toBe('srv-1');
    expect(rows[0]?.syncStatus).toBe('sent');
  });

  it('ne défait pas un « supprimer pour moi »', () => {
    db.insert(messages)
      .values({
        clientId: 'cli-1',
        conversationId: CONV,
        body: 'bonjour',
        hiddenLocally: true,
        createdAt: clock.now(),
      })
      .run();

    applyMessagePage(db, CONV, [remoteMessage({ changeSeq: 2 })], clock.now());

    // C'est une décision de cet appareil, que le serveur ignore.
    expect(db.select().from(messages).get()?.hiddenLocally).toBe(true);
  });

  it('applique une suppression venue du serveur', () => {
    applyMessagePage(db, CONV, [remoteMessage()], clock.now());
    applyMessagePage(
      db,
      CONV,
      [remoteMessage({ changeSeq: 2, body: null, deletedAt: clock.now() })],
      clock.now(),
    );

    const row = db.select().from(messages).get();
    expect(row?.body).toBeNull();
    expect(row?.deletedAt).not.toBeNull();
  });

  it('ne fait jamais reculer le curseur de lecture', () => {
    applyConversations(db, [remoteConversation({ lastReadSeq: 5 })]);

    // L'utilisateur lit hors ligne : l'accusé est posé localement et attend
    // dans la file. Le serveur, lui, en est resté à 5.
    db.update(conversations).set({ lastReadSeq: 12 }).where(eq(conversations.id, CONV)).run();

    applyConversations(db, [remoteConversation({ lastReadSeq: 5 })]);

    // Le reprendre tel quel ferait réapparaître comme non lus sept messages
    // que l'utilisateur vient de lire.
    expect(db.select().from(conversations).get()?.lastReadSeq).toBe(12);
  });

  it('préserve la date d’ouverture locale', () => {
    applyConversations(db, [remoteConversation()]);
    db.update(conversations)
      .set({ lastOpenedAt: clock.now() })
      .where(eq(conversations.id, CONV))
      .run();

    applyConversations(db, [remoteConversation({ title: 'Nouveau titre' })]);

    const row = db.select().from(conversations).get();
    expect(row?.title).toBe('Nouveau titre');
    // Sans cela, l'ordre de priorité de la synchronisation serait remis à plat
    // à chaque passe.
    expect(row?.lastOpenedAt).toBe(clock.now());
  });

  it('marque une conversation venue du serveur comme non locale', () => {
    db.insert(conversations)
      .values({ id: CONV, type: 'group', localOnly: true, createdAt: clock.now() })
      .run();

    applyConversations(db, [remoteConversation()]);

    expect(db.select().from(conversations).get()?.localOnly).toBe(false);
  });

  it('remet le curseur à zéro et note la date', () => {
    applyMessagePage(db, CONV, [remoteMessage({ changeSeq: 7 })], clock.now());
    resetCursor(db, CONV, clock.now());

    const row = db.select().from(syncState).get();
    expect(row?.lastChangeSeq).toBe(0);
    expect(row?.resetAt).toBe(clock.now());
  });

  it('réveille l’écran de la conversation écrite', () => {
    // Les repositories ne sont plus les seuls à écrire : la synchronisation et
    // le temps réel écrivent directement. Tant que l'émetteur restait privé au
    // repository, ces écritures étaient invisibles pour l'interface — le
    // message arrivait en base et l'écran ne bougeait pas.
    const woken: string[] = [];
    const stopMessages = messageChanges.subscribe(CONV, () => woken.push('messages'));
    const stopList = conversationChanges.subscribe(() => woken.push('liste'));

    applyMessagePage(db, CONV, [remoteMessage()], clock.now());

    expect(woken).toEqual(['messages', 'liste']);
    stopMessages();
    stopList();
  });

  it('ne réveille pas les écrans des autres conversations', () => {
    // Sans cette granularité, chaque message reçu dans n'importe quel fil
    // re-rendrait tous les écrans ouverts.
    let woken = 0;
    const stop = messageChanges.subscribe('conv-2', () => (woken += 1));

    applyMessagePage(db, CONV, [remoteMessage()], clock.now());

    expect(woken).toBe(0);
    stop();
  });

  it('n’écrit rien pour une page vide', () => {
    expect(applyMessagePage(db, CONV, [], clock.now())).toBe(0);
    // Le curseur ne doit pas être créé pour rien : une ligne de sync_state
    // avec un curseur à zéro est indiscernable d'un vrai état initial.
    expect(db.select().from(syncState).all()).toHaveLength(0);
  });
});
