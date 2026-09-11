import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';

import { OUTBOX_BACKOFF, type MessageRepository } from '@kola/core';

import { conversations, messages } from '../db/schema';
import { createClock, createIdGenerator, createTestDatabase } from '../db/testing';
import { createConversationRepository } from '../repositories/conversations';
import type { LocalDatabase } from '../repositories/database';
import { createMessageRepository } from '../repositories/messages';
import { count as outboxCount, pending } from '../repositories/outbox';

import { createOutboxProcessor, type OutboxProcessor } from './outbox-processor';
import { createFakeTransport, type FakeTransport } from './testing';

/**
 * Tests du moteur de vidage de la file.
 *
 * Le scénario de référence est en fin de fichier : couper le réseau, écrire dix
 * messages, redémarrer, rétablir. C'est celui qui décide si Kola tient sa
 * promesse ou non.
 */

const CONV = 'conv-1';
const OTHER = 'conv-2';
const ME = 'user-me';

describe('moteur de la file sortante', () => {
  let db: LocalDatabase;
  let close: () => void;
  let repo: MessageRepository;
  let transport: FakeTransport;
  let processor: OutboxProcessor;
  let clock: ReturnType<typeof createClock>;

  beforeEach(() => {
    const test = createTestDatabase();
    db = test.db;
    close = test.close;
    clock = createClock();
    transport = createFakeTransport();

    db.insert(conversations)
      .values([
        { id: CONV, type: 'group', title: 'Tontine', createdAt: clock.now() },
        { id: OTHER, type: 'group', title: 'Famille', createdAt: clock.now() },
      ])
      .run();

    repo = createMessageRepository({ db, now: clock.now, newId: createIdGenerator('msg') });
    processor = createOutboxProcessor({
      db,
      transport,
      now: clock.now,
      // Temporisation déterministe : pas d'aléatoire dans les tests.
      random: () => 0.5,
    });

    return () => close();
  });

  // -------------------------------------------------------------------------
  // Cas nominal
  // -------------------------------------------------------------------------

  it('envoie un message en attente et le marque comme parti', async () => {
    const message = await repo.sendMessage({ conversationId: CONV, senderId: ME, body: 'Bonjour' });

    const report = await processor.runOnce();

    expect(report.sent).toBe(1);
    expect(transport.received).toHaveLength(1);

    const row = db.select().from(messages).where(eq(messages.clientId, message.clientId)).get();
    expect(row?.syncStatus).toBe('sent');
    // Le serveur fait foi pour l'identifiant et le seq.
    expect(row?.id).toBe('srv-1');
    expect(row?.seq).toBe(1);

    // L'entrée quitte la file une fois confirmée.
    expect(outboxCount(db)).toBe(0);
  });

  it('ne fait rien sur une file vide', async () => {
    const report = await processor.runOnce();
    expect(report).toEqual({ sent: 0, deferred: 0, abandoned: 0, blocked: 0 });
  });

  it('propage une édition et une suppression', async () => {
    db.insert(messages)
      .values({
        clientId: 'c1',
        id: 'srv-9',
        conversationId: CONV,
        senderId: ME,
        seq: 4,
        body: 'original',
        createdAt: clock.now(),
        syncStatus: 'sent',
      })
      .run();

    await repo.editMessage('c1', 'corrigé');
    await processor.runOnce();
    expect(transport.edited).toEqual([{ clientId: 'c1', messageId: 'srv-9', body: 'corrigé' }]);

    await repo.deleteMessage('c1', true);
    await processor.runOnce();
    expect(transport.deleted).toEqual([{ clientId: 'c1', messageId: 'srv-9' }]);
  });

  // -------------------------------------------------------------------------
  // Ordre par conversation
  // -------------------------------------------------------------------------

  it('envoie les messages dans l’ordre où ils ont été écrits', async () => {
    for (let i = 1; i <= 5; i += 1) {
      clock.advance(100);
      await repo.sendMessage({ conversationId: CONV, senderId: ME, body: `message ${i}` });
    }

    await processor.runOnce();

    expect(transport.received.map((m) => m.body)).toEqual([
      'message 1',
      'message 2',
      'message 3',
      'message 4',
      'message 5',
    ]);
  });

  it('bloque la conversation dont une entrée a échoué, et elle seule', async () => {
    await repo.sendMessage({ conversationId: CONV, senderId: ME, body: 'A1' });
    await repo.sendMessage({ conversationId: CONV, senderId: ME, body: 'A2' });
    await repo.sendMessage({ conversationId: OTHER, senderId: ME, body: 'B1' });

    // Le premier message échoue de façon transitoire.
    transport.failNextWith(500);
    const report = await processor.runOnce();

    // A2 n'est pas tenté : l'envoyer le ferait arriver avant A1 chez le
    // destinataire, dans le désordre.
    expect(report.deferred).toBe(1);
    expect(report.blocked).toBe(1);
    // L'autre conversation n'est pas concernée par l'échec.
    expect(report.sent).toBe(1);
    expect(transport.received.map((m) => m.body)).toEqual(['B1']);
  });

  it('reprend dans le bon ordre à la passe suivante', async () => {
    await repo.sendMessage({ conversationId: CONV, senderId: ME, body: 'A1' });
    await repo.sendMessage({ conversationId: CONV, senderId: ME, body: 'A2' });

    transport.failNextWith(500);
    await processor.runOnce();
    expect(transport.received).toHaveLength(0);

    // Le temps passe, la temporisation expire.
    clock.advance(OUTBOX_BACKOFF.maxMs);
    await processor.runOnce();

    expect(transport.received.map((m) => m.body)).toEqual(['A1', 'A2']);
  });

  // -------------------------------------------------------------------------
  // Erreurs
  // -------------------------------------------------------------------------

  it('reprogramme après une erreur transitoire, sans perdre le message', async () => {
    const message = await repo.sendMessage({ conversationId: CONV, senderId: ME, body: 'Bonjour' });

    transport.goOffline();
    const report = await processor.runOnce();

    expect(report.deferred).toBe(1);
    // L'entrée reste en file : rien n'est perdu.
    expect(outboxCount(db)).toBe(1);

    const row = db.select().from(messages).where(eq(messages.clientId, message.clientId)).get();
    // Toujours « en attente », pas « échec » : il repartira tout seul.
    expect(row?.syncStatus).toBe('pending');
  });

  it('abandonne sur une erreur définitive et signale l’échec à l’utilisateur', async () => {
    const message = await repo.sendMessage({ conversationId: CONV, senderId: ME, body: 'Bonjour' });

    // Un refus RLS : insister n'aboutira jamais.
    transport.failNextWith(403);
    const report = await processor.runOnce();

    expect(report.abandoned).toBe(1);
    expect(outboxCount(db)).toBe(0);

    const row = db.select().from(messages).where(eq(messages.clientId, message.clientId)).get();
    // L'utilisateur doit voir « échec » et pouvoir relancer à la main (#32).
    expect(row?.syncStatus).toBe('failed');
  });

  it('réessaie sur un débit limité plutôt que d’abandonner', async () => {
    await repo.sendMessage({ conversationId: CONV, senderId: ME, body: 'Bonjour' });

    transport.failNextWith(429);
    const report = await processor.runOnce();

    expect(report.abandoned).toBe(0);
    expect(report.deferred).toBe(1);
    expect(outboxCount(db)).toBe(1);
  });

  it('abandonne après épuisement des tentatives', async () => {
    const message = await repo.sendMessage({ conversationId: CONV, senderId: ME, body: 'Bonjour' });

    transport.goOffline();
    for (let attempt = 0; attempt < OUTBOX_BACKOFF.maxRetries; attempt += 1) {
      clock.advance(OUTBOX_BACKOFF.maxMs);
      await processor.runOnce();
    }

    expect(outboxCount(db)).toBe(0);
    const row = db.select().from(messages).where(eq(messages.clientId, message.clientId)).get();
    expect(row?.syncStatus).toBe('failed');
  });

  it('permet de relancer un message en échec', async () => {
    const message = await repo.sendMessage({ conversationId: CONV, senderId: ME, body: 'Bonjour' });

    transport.failNextWith(500);
    for (let attempt = 0; attempt < OUTBOX_BACKOFF.maxRetries; attempt += 1) {
      clock.advance(OUTBOX_BACKOFF.maxMs);
      transport.failNextWith(500);
      await processor.runOnce();
    }
    expect(outboxCount(db)).toBe(0);

    // L'utilisateur touche « réessayer ».
    await repo.retryMessage(message.clientId);
    const report = await processor.runOnce();

    expect(report.sent).toBe(1);
    expect(transport.received).toHaveLength(1);
  });

  // -------------------------------------------------------------------------
  // Idempotence
  // -------------------------------------------------------------------------

  it('traite un doublon serveur comme un succès', async () => {
    const message = await repo.sendMessage({ conversationId: CONV, senderId: ME, body: 'Bonjour' });

    // Premier envoi : reçu par le serveur, mais la réponse se perd.
    await processor.runOnce();
    expect(transport.received).toHaveLength(1);

    // L'outbox réémet : le serveur répond « déjà reçu ».
    await repo.retryMessage(message.clientId);
    const report = await processor.runOnce();

    // Ce n'est pas une erreur : c'est l'idempotence qui fonctionne.
    expect(report.sent).toBe(1);
    expect(report.abandoned).toBe(0);
    // Et surtout, aucun doublon côté serveur.
    expect(transport.received).toHaveLength(1);

    const row = db.select().from(messages).where(eq(messages.clientId, message.clientId)).get();
    expect(row?.syncStatus).toBe('sent');
  });

  it('n’envoie jamais deux fois le même message sur cent cycles de coupure', async () => {
    await repo.sendMessage({ conversationId: CONV, senderId: ME, body: 'unique' });

    for (let cycle = 0; cycle < 100; cycle += 1) {
      transport.goOffline();
      await processor.runOnce();
      transport.goOnline();
      clock.advance(OUTBOX_BACKOFF.maxMs);
      await processor.runOnce();
    }

    expect(transport.received).toHaveLength(1);
    expect(transport.received[0]?.body).toBe('unique');
  });

  // -------------------------------------------------------------------------
  // Concurrence
  // -------------------------------------------------------------------------

  it('ne lance pas deux passes en parallèle', async () => {
    for (let i = 1; i <= 3; i += 1) {
      await repo.sendMessage({ conversationId: CONV, senderId: ME, body: `m${i}` });
    }

    // Deux déclenchements simultanés : au retour du réseau, le détecteur et le
    // minuteur peuvent très bien tirer en même temps.
    const [first, second] = await Promise.all([processor.runOnce(), processor.runOnce()]);

    const total = first.sent + second.sent;
    expect(total).toBe(3);
    // Trois messages envoyés, pas six.
    expect(transport.received).toHaveLength(3);
  });

  // -------------------------------------------------------------------------
  // Accusés de lecture
  // -------------------------------------------------------------------------

  it('envoie les accusés de lecture', async () => {
    db.insert(messages)
      .values({
        clientId: 'c1',
        id: 'srv-1',
        conversationId: CONV,
        senderId: 'autre',
        seq: 3,
        body: 'salut',
        createdAt: clock.now(),
        syncStatus: 'sent',
      })
      .run();

    const { createConversationRepository } = await import('../repositories/conversations');
    const conversationRepo = createConversationRepository({ db, now: clock.now });
    db.update(conversations).set({ lastSeq: 3 }).where(eq(conversations.id, CONV)).run();

    await conversationRepo.markRead(CONV, 3);
    await processor.runOnce();

    expect(transport.reads).toEqual([{ conversationId: CONV, upToSeq: 3 }]);
  });

  // -------------------------------------------------------------------------
  // Robustesse
  // -------------------------------------------------------------------------

  it('abandonne une opération inconnue plutôt que de bloquer la file', async () => {
    const { enqueue } = await import('../repositories/outbox');
    // Vient forcément d'une version antérieure de l'application : elle ne
    // partira jamais, et bloquerait la conversation indéfiniment.
    enqueue(
      db,
      {
        operation: 'operation_disparue' as never,
        entityId: 'x',
        conversationId: CONV,
        payload: {},
      },
      clock.now(),
    );

    const report = await processor.runOnce();

    expect(report.abandoned).toBe(1);
    expect(outboxCount(db)).toBe(0);
  });

  it('notifie l’interface après une passe utile, et pas après une passe vide', async () => {
    const reports: number[] = [];
    const watched = createOutboxProcessor({
      db,
      transport,
      now: clock.now,
      random: () => 0.5,
      onChange: (report) => reports.push(report.sent),
    });

    await watched.runOnce();
    expect(reports).toEqual([]);

    await repo.sendMessage({ conversationId: CONV, senderId: ME, body: 'Bonjour' });
    await watched.runOnce();
    expect(reports).toEqual([1]);
  });

  // -------------------------------------------------------------------------
  // Le scénario de référence
  // -------------------------------------------------------------------------

  it('mode avion, dix messages, redémarrage, retour du réseau', async () => {
    // 1. Le réseau est coupé. L'utilisateur écrit quand même.
    transport.goOffline();

    for (let i = 1; i <= 10; i += 1) {
      clock.advance(1000);
      await repo.sendMessage({ conversationId: CONV, senderId: ME, body: `message ${i}` });
    }

    // 2. Le moteur tourne dans le vide sans rien perdre.
    const offlineReport = await processor.runOnce();
    expect(offlineReport.sent).toBe(0);
    expect(transport.received).toHaveLength(0);
    expect(outboxCount(db)).toBe(10);

    // 3. L'application est tuée puis relancée : nouveau moteur, même base.
    const afterRestart = createOutboxProcessor({
      db,
      transport,
      now: clock.now,
      random: () => 0.5,
    });

    // 4. Le réseau revient.
    transport.goOnline();
    clock.advance(OUTBOX_BACKOFF.maxMs);
    const report = await afterRestart.runOnce();

    // Les dix messages sont partis, dans l'ordre d'écriture, sans doublon.
    expect(report.sent).toBe(10);
    expect(transport.received.map((m) => m.body)).toEqual(
      Array.from({ length: 10 }, (_, i) => `message ${i + 1}`),
    );

    // La file est vide et tout est marqué comme parti.
    expect(outboxCount(db)).toBe(0);
    expect(pending(db, clock.now())).toHaveLength(0);

    const rows = db.select().from(messages).where(eq(messages.conversationId, CONV)).all();
    expect(rows).toHaveLength(10);
    expect(rows.every((r) => r.syncStatus === 'sent')).toBe(true);
    // Chaque message a reçu son seq du serveur, sans trou ni collision.
    expect([...rows].map((r) => r.seq).sort((a, b) => (a ?? 0) - (b ?? 0))).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8, 9, 10,
    ]);
  });
});

describe('création de groupe', () => {
  it('envoie le groupe et le marque comme existant côté serveur', async () => {
    const test = createTestDatabase();
    const db = test.db;
    const clock = createClock();
    const transport = createFakeTransport();

    const repo = createConversationRepository({
      db,
      now: clock.now,
      newId: createIdGenerator('grp'),
    });
    await repo.createGroup({ title: 'Tontine', memberIds: ['u1'] });

    const report = await createOutboxProcessor({ db, transport, now: clock.now }).runOnce();

    expect(report.sent).toBe(1);
    expect(transport.createdGroups[0]?.title).toBe('Tontine');
    // Tant que `localOnly` reste vrai, l'interface doit signaler un groupe qui
    // n'existe pas encore ailleurs. La remise à zéro est le seul signal fiable
    // que la création a abouti.
    expect(db.select().from(conversations).get()?.localOnly).toBe(false);
    test.close();
  });

  it('ne crée pas deux groupes après un échec transitoire', async () => {
    const test = createTestDatabase();
    const db = test.db;
    const clock = createClock();
    const transport = createFakeTransport();

    const repo = createConversationRepository({
      db,
      now: clock.now,
      newId: createIdGenerator('grp'),
    });
    await repo.createGroup({ title: 'Tontine', memberIds: [] });

    const processor = createOutboxProcessor({ db, transport, now: clock.now });

    transport.goOffline();
    await processor.runOnce();
    transport.goOnline();
    // La temporisation exponentielle diffère la réémission : sans avancer
    // l'horloge, la seconde passe ne tenterait rien et le test passerait pour
    // la mauvaise raison.
    clock.advance(10 * 60 * 1000);
    await processor.runOnce();

    expect(transport.createdGroups).toHaveLength(1);
    expect(db.select().from(conversations).all()).toHaveLength(1);
    expect(db.select().from(conversations).get()?.localOnly).toBe(false);
    test.close();
  });

  // L'idempotence côté serveur — deux appels de même `client_id` rendent le même
  // groupe — est vérifiée là où elle vit, dans 008_groups_and_system_messages.sql.
});
