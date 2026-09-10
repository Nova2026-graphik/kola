import { beforeEach, describe, expect, it } from 'vitest';

import type { ConversationRepository } from '@kola/core';

import { conversationMembers, conversations } from '../db/schema';
import { createClock, createIdGenerator, createTestDatabase } from '../db/testing';

import { createConversationRepository } from './conversations';
import type { LocalDatabase } from './database';
import { count as outboxCount, pending } from './outbox';

describe('ConversationRepository', () => {
  let db: LocalDatabase;
  let close: () => void;
  let repo: ConversationRepository;
  let clock: ReturnType<typeof createClock>;

  beforeEach(() => {
    const test = createTestDatabase();
    db = test.db;
    close = test.close;
    clock = createClock();
    repo = createConversationRepository({ db, now: clock.now });
    return () => close();
  });

  it('trie par date du dernier message, la plus récente en tête', async () => {
    db.insert(conversations)
      .values([
        { id: 'a', type: 'group', title: 'A', lastMessageAt: 1000, createdAt: 0 },
        { id: 'b', type: 'group', title: 'B', lastMessageAt: 3000, createdAt: 0 },
        { id: 'c', type: 'group', title: 'C', lastMessageAt: 2000, createdAt: 0 },
      ])
      .run();

    const list = await repo.listConversations();
    expect(list.map((c) => c.id)).toEqual(['b', 'c', 'a']);
  });

  it('remonte les conversations épinglées', async () => {
    db.insert(conversations)
      .values([
        { id: 'a', type: 'group', title: 'A', lastMessageAt: 5000, createdAt: 0 },
        { id: 'b', type: 'group', title: 'B', lastMessageAt: 1000, pinnedAt: 900, createdAt: 0 },
      ])
      .run();

    const list = await repo.listConversations();
    expect(list.map((c) => c.id)).toEqual(['b', 'a']);
  });

  it('masque les conversations archivées', async () => {
    db.insert(conversations)
      .values([
        { id: 'a', type: 'group', title: 'A', lastMessageAt: 1000, createdAt: 0 },
        { id: 'b', type: 'group', title: 'B', lastMessageAt: 2000, archivedAt: 1500, createdAt: 0 },
      ])
      .run();

    const list = await repo.listConversations();
    expect(list.map((c) => c.id)).toEqual(['a']);
  });

  it('dérive le compte de non-lus sans agrégation sur les messages', async () => {
    db.insert(conversations)
      .values({
        id: 'a',
        type: 'group',
        title: 'A',
        lastSeq: 12,
        lastReadSeq: 5,
        createdAt: 0,
      })
      .run();

    const conversation = await repo.getConversation('a');
    expect(conversation?.unreadCount).toBe(7);
  });

  it('n’affiche jamais un compte de non-lus négatif', async () => {
    // Peut arriver transitoirement : un accusé local part avant que le seq
    // serveur ne soit connu.
    db.insert(conversations)
      .values({ id: 'a', type: 'group', title: 'A', lastSeq: 3, lastReadSeq: 8, createdAt: 0 })
      .run();

    const conversation = await repo.getConversation('a');
    expect(conversation?.unreadCount).toBe(0);
  });

  describe('marquage comme lu', () => {
    beforeEach(() => {
      db.insert(conversations)
        .values({ id: 'a', type: 'group', title: 'A', lastSeq: 10, lastReadSeq: 3, createdAt: 0 })
        .run();
    });

    it('avance le curseur et met l’accusé en file', async () => {
      await repo.markRead('a', 8);

      const conversation = await repo.getConversation('a');
      expect(conversation?.lastReadSeq).toBe(8);
      expect(conversation?.unreadCount).toBe(2);

      const queued = pending(db, clock.now());
      expect(queued).toHaveLength(1);
      expect(queued[0]?.operation).toBe('mark_read');
      expect(queued[0]?.payload).toEqual({ conversationId: 'a', upToSeq: 8 });
    });

    it('ne fait jamais reculer le curseur', async () => {
      await repo.markRead('a', 8);
      // Un accusé en retard, arrivé après une salve de synchronisation, ne doit
      // pas ressusciter des non-lus déjà vus.
      await repo.markRead('a', 5);

      const conversation = await repo.getConversation('a');
      expect(conversation?.lastReadSeq).toBe(8);
    });

    it('ne dépense pas de requête pour un accusé déjà envoyé', async () => {
      await repo.markRead('a', 8);
      const before = outboxCount(db);

      await repo.markRead('a', 8);
      await repo.markRead('a', 2);

      // Une seule entrée en file, et pas de nouvelle mise en file inutile.
      expect(outboxCount(db)).toBe(before);
      expect(before).toBe(1);
    });

    it('groupe les accusés successifs en une seule entrée', async () => {
      await repo.markRead('a', 5);
      await repo.markRead('a', 7);
      await repo.markRead('a', 10);

      const queued = pending(db, clock.now());
      // Lire cinquante messages d'un coup doit produire une requête, pas
      // cinquante.
      expect(queued).toHaveLength(1);
      expect(queued[0]?.payload).toEqual({ conversationId: 'a', upToSeq: 10 });
    });
  });

  it('notifie les abonnés et se désabonne proprement', async () => {
    db.insert(conversations)
      .values({ id: 'a', type: 'group', title: 'A', lastSeq: 5, lastReadSeq: 0, createdAt: 0 })
      .run();

    let calls = 0;
    const stop = repo.subscribe(() => {
      calls += 1;
    });

    await repo.markRead('a', 3);
    expect(calls).toBe(1);

    stop();
    await repo.markRead('a', 5);
    expect(calls).toBe(1);
  });
});

describe('création de groupe', () => {
  let db: LocalDatabase;
  let repo: ConversationRepository;
  let clock: ReturnType<typeof createClock>;

  beforeEach(() => {
    const test = createTestDatabase();
    db = test.db;
    clock = createClock();
    repo = createConversationRepository({
      db,
      now: clock.now,
      newId: createIdGenerator('grp'),
    });
    return () => {
      test.close();
    };
  });

  it('crée le groupe localement et le met en file, en une transaction', async () => {
    const group = await repo.createGroup({ title: 'Tontine', memberIds: ['u1', 'u2'] });

    expect(group.title).toBe('Tontine');
    expect(db.select().from(conversations).get()?.localOnly).toBe(true);

    const queued = pending(db, clock.now());
    expect(queued).toHaveLength(1);
    expect(queued[0]?.operation).toBe('create_group');
    // Une création réussie avec une mise en file échouée produirait un groupe
    // qui ne partirait jamais, sans que rien ne le signale.
    expect((queued[0]?.payload as { memberIds: string[] }).memberIds).toEqual(['u1', 'u2']);
  });

  it('est utilisable hors ligne', async () => {
    // Le critère de #37 : la création hors ligne se met en file et aboutit au
    // retour du réseau. Rien ici ne touche au réseau — c'est tout l'intérêt.
    const group = await repo.createGroup({ title: 'Hors ligne', memberIds: [] });

    const listed = await repo.listConversations();
    expect(listed.map((c) => c.id)).toContain(group.id);
  });

  it('remonte en tête de la liste', async () => {
    // Un groupe qu'on vient de créer et qu'on ne retrouve pas donne
    // l'impression que la création a échoué.
    db.insert(conversations)
      .values({ id: 'ancien', type: 'group', title: 'Ancien', lastMessageAt: clock.now() - 1000 })
      .run();

    const group = await repo.createGroup({ title: 'Nouveau', memberIds: [] });
    const listed = await repo.listConversations();

    expect(listed[0]?.id).toBe(group.id);
  });

  it('refuse un nom vide ou trop long', async () => {
    await expect(repo.createGroup({ title: '   ', memberIds: [] })).rejects.toThrow();
    await expect(repo.createGroup({ title: 'x'.repeat(81), memberIds: [] })).rejects.toThrow();
    expect(db.select().from(conversations).all()).toHaveLength(0);
  });

  it('n’écrit pas la composition localement', async () => {
    // Le serveur filtre la liste — profils inexistants, personnes ayant bloqué
    // le créateur. Recopier les membres ici afficherait une composition qui
    // pourrait être fausse jusqu'à la première synchronisation.
    await repo.createGroup({ title: 'Tontine', memberIds: ['inexistant'] });
    expect(db.select().from(conversationMembers).all()).toHaveLength(0);
  });
});
