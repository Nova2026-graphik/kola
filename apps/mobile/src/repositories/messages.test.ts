import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';

import type { MessageRepository } from '@kola/core';

import { conversations, messages, outbox } from '../db/schema';
import { createClock, createIdGenerator, createTestDatabase } from '../db/testing';

import type { LocalDatabase } from './database';
import { createMessageRepository, countUnsent } from './messages';
import { count as outboxCount, pending } from './outbox';

/**
 * Tests du MessageRepository.
 *
 * Le scénario qui compte vraiment est en fin de fichier : couper le réseau,
 * écrire, redémarrer, rétablir. C'est celui qui décide si Kola est utilisable
 * au Togo ou non.
 */

const CONVERSATION = 'conv-1';
const ME = 'user-me';

describe('MessageRepository', () => {
  let db: LocalDatabase;
  let close: () => void;
  let repo: MessageRepository;
  let clock: ReturnType<typeof createClock>;

  beforeEach(() => {
    const test = createTestDatabase();
    db = test.db;
    close = test.close;
    clock = createClock();

    db.insert(conversations)
      .values({ id: CONVERSATION, type: 'group', title: 'Tontine', createdAt: clock.now() })
      .run();

    repo = createMessageRepository({
      db,
      now: clock.now,
      newId: createIdGenerator('msg'),
    });

    return () => close();
  });

  // -------------------------------------------------------------------------
  // Écriture optimiste
  // -------------------------------------------------------------------------

  it("insère le message localement et l'affiche immédiatement", async () => {
    const message = await repo.sendMessage({
      conversationId: CONVERSATION,
      senderId: ME,
      body: 'Bonjour',
    });

    expect(message.body).toBe('Bonjour');
    expect(message.syncStatus).toBe('pending');
    // Pas encore de seq ni d'identifiant serveur : rien n'est parti.
    expect(message.seq).toBeNull();
    expect(message.id).toBeNull();
  });

  it('rend la lecture immédiatement cohérente avec ce qui vient d’être écrit', async () => {
    await repo.sendMessage({ conversationId: CONVERSATION, senderId: ME, body: 'Bonjour' });

    const page = await repo.getMessages({ conversationId: CONVERSATION });
    expect(page).toHaveLength(1);
    expect(page[0]?.body).toBe('Bonjour');
  });

  // -------------------------------------------------------------------------
  // Atomicité — le point critique de l'architecture
  // -------------------------------------------------------------------------

  it('met le message en file dans la même opération que son insertion', async () => {
    const message = await repo.sendMessage({
      conversationId: CONVERSATION,
      senderId: ME,
      body: 'Bonjour',
    });

    const queued = pending(db, clock.now());
    expect(queued).toHaveLength(1);
    expect(queued[0]?.operation).toBe('send_message');
    expect(queued[0]?.entityId).toBe(message.clientId);
  });

  it("n'insère rien quand la mise en file échoue", async () => {
    // Une entrée occupe déjà la place, avec une charge utile invalide qui fera
    // échouer la transaction au moment de l'insertion du message.
    const repoWithFixedId = createMessageRepository({
      db,
      now: clock.now,
      newId: () => 'collision',
    });

    await repoWithFixedId.sendMessage({
      conversationId: CONVERSATION,
      senderId: ME,
      body: 'premier',
    });

    // Le même clientId : l'insertion du message viole la clé primaire.
    await expect(
      repoWithFixedId.sendMessage({
        conversationId: CONVERSATION,
        senderId: ME,
        body: 'second',
      }),
    ).rejects.toThrow();

    // Ni message fantôme, ni entrée de file orpheline.
    const all = db.select().from(messages).all();
    expect(all).toHaveLength(1);
    expect(all[0]?.body).toBe('premier');
    expect(outboxCount(db)).toBe(1);
  });

  // -------------------------------------------------------------------------
  // Idempotence
  // -------------------------------------------------------------------------

  it('ne crée pas de doublon quand un envoi est relancé', async () => {
    const message = await repo.sendMessage({
      conversationId: CONVERSATION,
      senderId: ME,
      body: 'Bonjour',
    });

    await repo.retryMessage(message.clientId);
    await repo.retryMessage(message.clientId);

    expect(db.select().from(messages).all()).toHaveLength(1);
    // Une seule entrée en file, malgré trois mises en file successives.
    expect(outboxCount(db)).toBe(1);
  });

  it('remet à zéro la temporisation quand on relance manuellement', async () => {
    const message = await repo.sendMessage({
      conversationId: CONVERSATION,
      senderId: ME,
      body: 'Bonjour',
    });

    db.update(outbox)
      .set({ retryCount: 5, nextAttemptAt: clock.now() + 60_000 })
      .where(eq(outbox.entityId, message.clientId))
      .run();

    await repo.retryMessage(message.clientId);

    const entry = db.select().from(outbox).where(eq(outbox.entityId, message.clientId)).get();
    expect(entry?.retryCount).toBe(0);
    expect(entry?.nextAttemptAt).toBe(clock.now());
  });

  // -------------------------------------------------------------------------
  // Ordre de lecture
  // -------------------------------------------------------------------------

  it('place les messages en attente après ceux qui ont un seq', async () => {
    // Deux messages déjà synchronisés.
    db.insert(messages)
      .values([
        {
          clientId: 'sync-1',
          id: 'srv-1',
          conversationId: CONVERSATION,
          senderId: 'autre',
          seq: 1,
          body: 'ancien',
          createdAt: clock.now(),
          syncStatus: 'sent',
        },
        {
          clientId: 'sync-2',
          id: 'srv-2',
          conversationId: CONVERSATION,
          senderId: 'autre',
          seq: 2,
          body: 'récent',
          createdAt: clock.now(),
          syncStatus: 'sent',
        },
      ])
      .run();

    clock.advance(1000);
    await repo.sendMessage({ conversationId: CONVERSATION, senderId: ME, body: 'le mien' });

    const page = await repo.getMessages({ conversationId: CONVERSATION });
    // Tri décroissant : le plus récent d'abord, donc le message en attente.
    expect(page.map((m) => m.body)).toEqual(['le mien', 'récent', 'ancien']);
  });

  it('pagine par curseur seq, jamais par offset', async () => {
    db.insert(messages)
      .values(
        Array.from({ length: 10 }, (_, i) => ({
          clientId: `sync-${i}`,
          id: `srv-${i}`,
          conversationId: CONVERSATION,
          senderId: 'autre',
          seq: i + 1,
          body: `message ${i + 1}`,
          createdAt: clock.now() + i,
          syncStatus: 'sent' as const,
        })),
      )
      .run();

    const firstPage = await repo.getMessages({ conversationId: CONVERSATION, limit: 4 });
    expect(firstPage.map((m) => m.seq)).toEqual([10, 9, 8, 7]);

    const secondPage = await repo.getMessages({
      conversationId: CONVERSATION,
      beforeSeq: 7,
      limit: 4,
    });
    expect(secondPage.map((m) => m.seq)).toEqual([6, 5, 4, 3]);
  });

  it('ne mélange pas les conversations', async () => {
    db.insert(conversations)
      .values({ id: 'conv-2', type: 'group', title: 'Autre', createdAt: clock.now() })
      .run();

    await repo.sendMessage({ conversationId: CONVERSATION, senderId: ME, body: 'ici' });
    await repo.sendMessage({ conversationId: 'conv-2', senderId: ME, body: 'ailleurs' });

    const page = await repo.getMessages({ conversationId: CONVERSATION });
    expect(page).toHaveLength(1);
    expect(page[0]?.body).toBe('ici');
  });

  // -------------------------------------------------------------------------
  // Modification et suppression
  // -------------------------------------------------------------------------

  it("met à jour l'envoi en attente plutôt que d'empiler une édition", async () => {
    const message = await repo.sendMessage({
      conversationId: CONVERSATION,
      senderId: ME,
      body: 'brouillon',
    });

    await repo.editMessage(message.clientId, 'version corrigée');

    const queued = pending(db, clock.now());
    // Le message n'est jamais parti : rien à éditer côté serveur, il suffit de
    // corriger la charge utile de l'envoi encore en file.
    expect(queued).toHaveLength(1);
    expect(queued[0]?.operation).toBe('send_message');
    expect((queued[0]?.payload as { body: string }).body).toBe('version corrigée');
  });

  it('propage une édition quand le message est déjà parti', async () => {
    db.insert(messages)
      .values({
        clientId: 'sent-1',
        id: 'srv-1',
        conversationId: CONVERSATION,
        senderId: ME,
        seq: 1,
        body: 'original',
        createdAt: clock.now(),
        syncStatus: 'sent',
      })
      .run();

    await repo.editMessage('sent-1', 'corrigé');

    const queued = pending(db, clock.now());
    expect(queued).toHaveLength(1);
    expect(queued[0]?.operation).toBe('edit_message');
  });

  it('conserve la ligne et le seq à la suppression pour tous', async () => {
    db.insert(messages)
      .values({
        clientId: 'sent-1',
        id: 'srv-1',
        conversationId: CONVERSATION,
        senderId: ME,
        seq: 7,
        body: 'à supprimer',
        createdAt: clock.now(),
        syncStatus: 'sent',
      })
      .run();

    await repo.deleteMessage('sent-1', true);

    const row = db.select().from(messages).where(eq(messages.clientId, 'sent-1')).get();
    // Suppression logique : un DELETE physique creuserait un trou dans la suite
    // des seq et casserait la reprise par curseur (ADR-0002).
    expect(row).toBeDefined();
    expect(row?.seq).toBe(7);
    expect(row?.deletedAt).not.toBeNull();
    expect(row?.body).toBeNull();
  });

  it("annule l'envoi d'un message supprimé avant d'être parti", async () => {
    const message = await repo.sendMessage({
      conversationId: CONVERSATION,
      senderId: ME,
      body: 'oups',
    });

    await repo.deleteMessage(message.clientId, true);

    // Rien à envoyer : ni l'envoi initial, ni une suppression pour un message
    // que le serveur n'a jamais vu.
    expect(outboxCount(db)).toBe(0);
  });

  it('ne propage rien pour une suppression locale', async () => {
    db.insert(messages)
      .values({
        clientId: 'sent-1',
        id: 'srv-1',
        conversationId: CONVERSATION,
        senderId: 'autre',
        seq: 1,
        body: 'message d’un autre',
        createdAt: clock.now(),
        syncStatus: 'sent',
      })
      .run();

    await repo.deleteMessage('sent-1', false);

    expect(outboxCount(db)).toBe(0);
    const page = await repo.getMessages({ conversationId: CONVERSATION });
    expect(page).toHaveLength(0);

    // La ligne reste : c'est un masquage, pas une suppression.
    const row = db.select().from(messages).where(eq(messages.clientId, 'sent-1')).get();
    expect(row?.hiddenLocally).toBe(true);
    expect(row?.deletedAt).toBeNull();
  });

  it('refuse de modifier un message supprimé', async () => {
    db.insert(messages)
      .values({
        clientId: 'sent-1',
        id: 'srv-1',
        conversationId: CONVERSATION,
        senderId: ME,
        seq: 1,
        body: null,
        deletedAt: clock.now(),
        createdAt: clock.now(),
        syncStatus: 'sent',
      })
      .run();

    await expect(repo.editMessage('sent-1', 'tentative')).rejects.toThrow(/supprimé/);
  });

  it('retire un message abandonné, file comprise', async () => {
    const message = await repo.sendMessage({
      conversationId: CONVERSATION,
      senderId: ME,
      body: 'à jeter',
    });

    await repo.discardMessage(message.clientId);

    expect(db.select().from(messages).all()).toHaveLength(0);
    expect(outboxCount(db)).toBe(0);
  });

  // -------------------------------------------------------------------------
  // Abonnements
  // -------------------------------------------------------------------------

  it('notifie la conversation concernée, et elle seule', async () => {
    db.insert(conversations)
      .values({ id: 'conv-2', type: 'group', title: 'Autre', createdAt: clock.now() })
      .run();

    let hereCalls = 0;
    let elsewhereCalls = 0;
    const stop = repo.subscribe(CONVERSATION, () => {
      hereCalls += 1;
    });
    repo.subscribe('conv-2', () => {
      elsewhereCalls += 1;
    });

    await repo.sendMessage({ conversationId: CONVERSATION, senderId: ME, body: 'ici' });

    expect(hereCalls).toBe(1);
    // Granularité : sans elle, chaque message re-rendrait toute la liste.
    expect(elsewhereCalls).toBe(0);

    stop();
    await repo.sendMessage({ conversationId: CONVERSATION, senderId: ME, body: 'encore' });
    expect(hereCalls).toBe(1);
  });

  // -------------------------------------------------------------------------
  // Le scénario qui décide de tout
  // -------------------------------------------------------------------------

  it('conserve dix messages écrits hors ligne, dans l’ordre, après redémarrage', async () => {
    const test = createTestDatabase();
    const persistentClock = createClock();
    const persistentRepo = createMessageRepository({
      db: test.db,
      now: persistentClock.now,
      newId: createIdGenerator('offline'),
    });

    test.db
      .insert(conversations)
      .values({
        id: CONVERSATION,
        type: 'group',
        title: 'Tontine',
        createdAt: persistentClock.now(),
      })
      .run();

    try {
      // Mode avion : dix messages écrits d'affilée.
      for (let i = 1; i <= 10; i += 1) {
        persistentClock.advance(1000);
        await persistentRepo.sendMessage({
          conversationId: CONVERSATION,
          senderId: ME,
          body: `message ${i}`,
        });
      }

      // L'application est tuée puis relancée : un nouveau repository, la même
      // base. Rien ne doit avoir été perdu.
      const afterRestart = createMessageRepository({
        db: test.db,
        now: persistentClock.now,
        newId: createIdGenerator('after'),
      });

      const page = await afterRestart.getMessages({ conversationId: CONVERSATION, limit: 20 });
      expect(page).toHaveLength(10);

      // Ils sont tous encore en attente, et affichés dans l'ordre d'écriture.
      expect(page.every((m) => m.syncStatus === 'pending')).toBe(true);
      expect([...page].reverse().map((m) => m.body)).toEqual(
        Array.from({ length: 10 }, (_, i) => `message ${i + 1}`),
      );

      // Et la file les rendra dans l'ordre où ils ont été écrits.
      const queued = pending(test.db, persistentClock.now(), 20);
      expect(queued).toHaveLength(10);
      expect(queued.map((q) => (q.payload as { body: string }).body)).toEqual(
        Array.from({ length: 10 }, (_, i) => `message ${i + 1}`),
      );

      expect(countUnsent(test.db, CONVERSATION)).toBe(10);
    } finally {
      test.close();
    }
  });
});
