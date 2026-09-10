import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';

import type {
  MessagePageQueryRemote,
  RemoteConversation,
  RemoteMessage,
  SyncTransport,
} from '@kola/core';

import { conversations, messages, syncState } from '../db/schema';
import { createClock, createTestDatabase } from '../db/testing';
import type { LocalDatabase } from '../repositories/database';
import { markConversationOpened } from '../repositories/sync';

import { createSyncEngine } from './engine';

/**
 * Tests du moteur de synchronisation delta.
 *
 * Le scénario décisif est en fin de fichier : cent coupures au pire moment
 * possible — entre la réponse du serveur et l'écriture locale. C'est celui qui
 * décide si un utilisateur perd des messages en zone de couverture instable, et
 * c'est un bug qu'on ne peut ni reproduire ni diagnostiquer après coup.
 */

const CONV = 'conv-1';
const OTHER = 'conv-2';

/** Serveur en mémoire : il applique le filtre `change_seq` comme le vrai. */
class FakeServer {
  readonly rows = new Map<string, RemoteMessage[]>();
  private counters = new Map<string, number>();
  /** Nombre de lignes servies. C'est la mesure du volume transféré. */
  served = 0;
  calls = 0;
  failNext = 0;

  post(conversationId: string, body: string, clientId?: string): RemoteMessage {
    const next = (this.counters.get(conversationId) ?? 0) + 1;
    this.counters.set(conversationId, next);

    const list = this.rows.get(conversationId) ?? [];
    const message: RemoteMessage = {
      id: `srv-${conversationId}-${String(next)}`,
      clientId: clientId ?? `cli-${conversationId}-${String(next)}`,
      conversationId,
      senderId: 'someone',
      seq: list.length + 1,
      changeSeq: next,
      kind: 'text',
      body,
      replyToId: null,
      editedAt: null,
      deletedAt: null,
      createdAt: 1_767_225_600_000 + next,
    };
    list.push(message);
    this.rows.set(conversationId, list);
    return message;
  }

  /** Modifie un message déjà émis : son seq ne bouge pas, son change_seq si. */
  edit(conversationId: string, clientId: string, body: string): void {
    const list = this.rows.get(conversationId) ?? [];
    const index = list.findIndex((row) => row.clientId === clientId);
    const previous = list[index];
    if (previous === undefined) {
      throw new Error(`message inconnu : ${clientId}`);
    }
    const next = (this.counters.get(conversationId) ?? 0) + 1;
    this.counters.set(conversationId, next);
    list[index] = { ...previous, body, changeSeq: next, editedAt: previous.createdAt + 1 };
  }

  remove(conversationId: string, clientId: string): void {
    const list = this.rows.get(conversationId) ?? [];
    const index = list.findIndex((row) => row.clientId === clientId);
    const previous = list[index];
    if (previous === undefined) {
      throw new Error(`message inconnu : ${clientId}`);
    }
    const next = (this.counters.get(conversationId) ?? 0) + 1;
    this.counters.set(conversationId, next);
    list[index] = { ...previous, body: null, deletedAt: previous.createdAt + 2, changeSeq: next };
  }

  lastChangeSeq(conversationId: string): number {
    return this.counters.get(conversationId) ?? 0;
  }

  /** Force un `last_change_seq` arbitraire — pour simuler une restauration. */
  rewind(conversationId: string, to: number): void {
    this.counters.set(conversationId, to);
  }

  transport(conversationIds: readonly string[] = [CONV]): SyncTransport {
    return {
      fetchConversations: () => Promise.resolve(conversationIds.map((id) => this.overview(id))),

      // La composition n'entre pas dans le rattrapage delta : elle est
      // récupérée à l'ouverture d'un fil (#38).
      fetchMembers: () => Promise.resolve([]),

      fetchMessages: (query: MessagePageQueryRemote) => {
        this.calls += 1;
        if (this.failNext > 0) {
          this.failNext -= 1;
          return Promise.reject(new Error('réseau coupé'));
        }
        const page = (this.rows.get(query.conversationId) ?? [])
          .filter((row) => row.changeSeq > query.afterChangeSeq)
          .sort((a, b) => a.changeSeq - b.changeSeq)
          .slice(0, query.limit);
        this.served += page.length;
        return Promise.resolve(page);
      },
    };
  }

  overview(id: string): RemoteConversation {
    return {
      id,
      type: 'group',
      title: `Conversation ${id}`,
      avatarUrl: null,
      ownerId: null,
      communityId: null,
      lastMessageAt: 1_767_225_600_000,
      lastMessagePreview: null,
      lastMessageSenderId: null,
      lastMessageKind: 'text',
      lastSeq: (this.rows.get(id) ?? []).length,
      lastChangeSeq: this.lastChangeSeq(id),
      lastReadSeq: 0,
      mutedUntil: null,
      pinnedAt: null,
      archivedAt: null,
      createdAt: 1_767_225_600_000,
      description: null,
      restricted: false,
      myRole: 'member',
    };
  }
}

describe('moteur de synchronisation delta', () => {
  let db: LocalDatabase;
  let close: () => void;
  let clock: ReturnType<typeof createClock>;
  let server: FakeServer;

  beforeEach(() => {
    const test = createTestDatabase();
    db = test.db;
    close = test.close;
    clock = createClock();
    server = new FakeServer();
    return () => {
      close();
    };
  });

  function engine(transport: SyncTransport, pageSize = 200) {
    return createSyncEngine({ db, transport, now: clock.now, pageSize });
  }

  function localBodies(conversationId = CONV): (string | null)[] {
    return db
      .select()
      .from(messages)
      .where(eq(messages.conversationId, conversationId))
      .all()
      .sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0))
      .map((row) => row.body);
  }

  function cursor(conversationId = CONV): number {
    return (
      db.select().from(syncState).where(eq(syncState.conversationId, conversationId)).get()
        ?.lastChangeSeq ?? 0
    );
  }

  it('récupère les messages et la liste des conversations', async () => {
    server.post(CONV, 'bonjour');
    server.post(CONV, 'ça va ?');

    const report = await engine(server.transport()).runOnce();

    expect(report.messages).toBe(2);
    expect(report.conversations).toBe(1);
    expect(localBodies()).toEqual(['bonjour', 'ça va ?']);
    expect(db.select().from(conversations).all()).toHaveLength(1);
  });

  it('ne récupère que ce qui manque à la passe suivante', async () => {
    server.post(CONV, 'un');
    server.post(CONV, 'deux');
    const sync = engine(server.transport());
    await sync.runOnce();

    const servedAfterFirstPass = server.served;
    server.post(CONV, 'trois');
    const report = await sync.runOnce();

    // Le critère d'acceptation : le volume est proportionnel à ce qui manque,
    // pas à la taille de l'historique.
    expect(server.served - servedAfterFirstPass).toBe(1);
    expect(report.messages).toBe(1);
    expect(localBodies()).toEqual(['un', 'deux', 'trois']);
  });

  it('ne fait aucun aller-retour quand rien n’a changé', async () => {
    server.post(CONV, 'un');
    const sync = engine(server.transport());
    await sync.runOnce();

    const callsAfterFirstPass = server.calls;
    await sync.runOnce();

    // Cinquante conversations inactives, c'est cinquante requêtes par passe si
    // on ne compare pas les compteurs d'abord.
    expect(server.calls).toBe(callsAfterFirstPass);
  });

  it('rattrape un message modifié après son émission', async () => {
    const first = server.post(CONV, 'bonjur');
    const sync = engine(server.transport());
    await sync.runOnce();
    expect(localBodies()).toEqual(['bonjur']);

    server.edit(CONV, first.clientId, 'bonjour');
    const report = await sync.runOnce();

    // C'est précisément ce qu'un curseur sur `seq` ne rattraperait pas.
    expect(report.messages).toBe(1);
    expect(localBodies()).toEqual(['bonjour']);
  });

  it('rattrape une suppression', async () => {
    const first = server.post(CONV, 'à supprimer');
    const sync = engine(server.transport());
    await sync.runOnce();

    server.remove(CONV, first.clientId);
    await sync.runOnce();

    const row = db.select().from(messages).where(eq(messages.clientId, first.clientId)).get();
    expect(row?.body).toBeNull();
    expect(row?.deletedAt).not.toBeNull();
  });

  it('ne réordonne pas le fil quand un message est modifié', async () => {
    const first = server.post(CONV, 'premier');
    server.post(CONV, 'deuxième');
    const sync = engine(server.transport());
    await sync.runOnce();

    server.edit(CONV, first.clientId, 'premier, corrigé');
    await sync.runOnce();

    expect(localBodies()).toEqual(['premier, corrigé', 'deuxième']);
  });

  it('pagine et avance le curseur après chaque page', async () => {
    for (let index = 0; index < 25; index += 1) {
      server.post(CONV, `message ${String(index)}`);
    }

    const report = await engine(server.transport(), 10).runOnce();

    expect(report.messages).toBe(25);
    expect(report.pages).toBe(3);
    expect(cursor()).toBe(25);
  });

  it('reprend exactement où la passe précédente s’est arrêtée', async () => {
    for (let index = 0; index < 25; index += 1) {
      server.post(CONV, `message ${String(index)}`);
    }

    // Le réseau tombe après la première page.
    const transport = server.transport();
    let pagesServed = 0;
    const flaky: SyncTransport = {
      fetchConversations: transport.fetchConversations,
      fetchMembers: transport.fetchMembers,
      fetchMessages: (query) => {
        pagesServed += 1;
        if (pagesServed > 1) {
          return Promise.reject(new Error('coupure'));
        }
        return transport.fetchMessages(query);
      },
    };

    const interrupted = await engine(flaky, 10).runOnce();
    expect(interrupted.messages).toBe(10);
    expect(interrupted.failed).toBe(1);
    expect(cursor()).toBe(10);

    const resumed = await engine(server.transport(), 10).runOnce();

    expect(resumed.messages).toBe(15);
    expect(localBodies()).toHaveLength(25);
  });

  it('n’avance pas le curseur quand l’écriture locale échoue', async () => {
    server.post(CONV, 'un');
    server.post(CONV, 'deux');

    // La base refuse l'écriture de la PAGE — la première transaction, celle de
    // la liste des conversations, passe. C'est le seul moment où l'ordre
    // « écrire puis avancer » se distingue de « avancer puis écrire ».
    // Inversé, ce test laisserait un curseur à 2 sur une base sans message, et
    // les deux messages seraient perdus définitivement.
    const real = db.transaction.bind(db);
    let transactions = 0;
    const broken = new Proxy(db, {
      get: (target, property, receiver) =>
        property === 'transaction'
          ? (...args: Parameters<typeof real>) => {
              transactions += 1;
              if (transactions > 1) {
                throw new Error('disque plein');
              }
              return real(...args);
            }
          : Reflect.get(target, property, receiver),
    }) as LocalDatabase;

    const report = await createSyncEngine({
      db: broken,
      transport: server.transport(),
      now: clock.now,
    }).runOnce();

    expect(report.failed).toBe(1);
    expect(report.messages).toBe(0);
    expect(cursor()).toBe(0);
  });

  it('termine proprement quand la base refuse toute écriture', async () => {
    server.post(CONV, 'un');

    const broken = new Proxy(db, {
      get: (target, property, receiver) =>
        property === 'transaction'
          ? () => {
              throw new Error('base verrouillée');
            }
          : Reflect.get(target, property, receiver),
    }) as LocalDatabase;

    // Une exception qui remonterait jusqu'ici laisserait l'indicateur bloqué
    // et, sur un déclenchement automatique, produirait un rejet non traité.
    const sync = createSyncEngine({ db: broken, transport: server.transport(), now: clock.now });
    const report = await sync.runOnce();

    expect(report.failed).toBe(1);
    expect(sync.getState().phase).toBe('idle');
    expect(sync.isRunning()).toBe(false);
  });

  it('continue les autres conversations quand une échoue', async () => {
    server.post(CONV, 'ici');
    server.post(OTHER, 'là-bas');

    const transport = server.transport([CONV, OTHER]);
    const partial: SyncTransport = {
      fetchConversations: transport.fetchConversations,
      fetchMembers: transport.fetchMembers,
      fetchMessages: (query) =>
        query.conversationId === CONV
          ? Promise.reject(new Error('refus'))
          : transport.fetchMessages(query),
    };

    const report = await engine(partial).runOnce();

    expect(report.failed).toBe(1);
    expect(report.messages).toBe(1);
    expect(localBodies(OTHER)).toEqual(['là-bas']);
  });

  it('remet le curseur à zéro quand il dépasse celui du serveur', async () => {
    server.post(CONV, 'un');
    server.post(CONV, 'deux');
    const sync = engine(server.transport());
    await sync.runOnce();
    expect(cursor()).toBe(2);

    // Base restaurée depuis une sauvegarde : le compteur du serveur a reculé.
    // Sans détection, le client attendrait indéfiniment des lignes qui ne
    // viendront jamais, et son fil resterait figé sans le signaler.
    server.rewind(CONV, 1);
    const report = await sync.runOnce();

    expect(report.reset).toBe(1);
    expect(db.select().from(syncState).get()?.resetAt).not.toBeNull();
  });

  it('donne la priorité à la conversation ouverte le plus récemment', async () => {
    server.post(CONV, 'ici');
    server.post(OTHER, 'là-bas');

    // Les deux conversations doivent exister localement pour porter la date
    // d'ouverture : c'est une colonne locale, sans équivalent serveur.
    await engine(server.transport([CONV, OTHER])).runOnce();
    markConversationOpened(db, OTHER, clock.now());

    const order: string[] = [];
    const transport = server.transport([CONV, OTHER]);
    const observed: SyncTransport = {
      fetchConversations: transport.fetchConversations,
      fetchMembers: transport.fetchMembers,
      fetchMessages: (query) => {
        order.push(query.conversationId);
        return transport.fetchMessages(query);
      },
    };

    server.post(CONV, 'encore ici');
    server.post(OTHER, 'encore là-bas');
    await engine(observed).runOnce();

    expect(order[0]).toBe(OTHER);
  });

  it('refuse deux passes concurrentes', async () => {
    server.post(CONV, 'un');
    const sync = engine(server.transport());

    const [first, second] = await Promise.all([sync.runOnce(), sync.runOnce()]);

    // Deux passes liraient le même curseur et paieraient deux fois le volume.
    expect(first.messages + second.messages).toBe(1);
  });

  it('publie son état pour un indicateur discret', async () => {
    server.post(CONV, 'un');
    const phases: string[] = [];

    const sync = createSyncEngine({
      db,
      transport: server.transport(),
      now: clock.now,
      onStateChange: (state) => phases.push(state.phase),
    });
    await sync.runOnce();

    expect(phases).toContain('conversations');
    expect(phases).toContain('messages');
    expect(sync.getState().phase).toBe('idle');
  });

  it('survit à une liste de conversations inaccessible', async () => {
    const report = await engine({
      fetchConversations: () => Promise.reject(new Error('hors ligne')),
      fetchMembers: () => Promise.reject(new Error('hors ligne')),
      fetchMessages: () => Promise.reject(new Error('hors ligne')),
    }).runOnce();

    // La base locale reste lisible : c'est tout l'intérêt du local-first.
    expect(report.failed).toBe(1);
    expect(report.messages).toBe(0);
  });

  // -------------------------------------------------------------------------
  // Le scénario décisif
  // -------------------------------------------------------------------------

  it('ne perd ni ne duplique aucun message après cent coupures', async () => {
    const sync = engine(server.transport(), 7);

    for (let round = 0; round < 100; round += 1) {
      server.post(CONV, `tour ${String(round)}`);

      // Une coupure sur deux, au pire moment : le serveur a répondu, la page
      // est en vol, et le réseau tombe avant que rien ne soit écrit.
      if (round % 2 === 0) {
        server.failNext = 1;
      }
      await sync.runOnce();
    }

    // Une dernière passe sans coupure pour rattraper le reliquat.
    server.failNext = 0;
    await sync.runOnce();

    const rows = db.select().from(messages).all();
    expect(rows).toHaveLength(100);

    const clientIds = new Set(rows.map((row) => row.clientId));
    expect(clientIds.size).toBe(100);

    expect(localBodies()).toEqual(
      Array.from({ length: 100 }, (_, index) => `tour ${String(index)}`),
    );
    expect(cursor()).toBe(server.lastChangeSeq(CONV));
  });
});

describe('composition des conversations', () => {
  it('rapatrie les membres du fil explicitement demandé', async () => {
    const test = createTestDatabase();
    const server = new FakeServer();
    server.post(CONV, 'bonjour');

    const asked: string[] = [];
    const base = server.transport();
    const sync = createSyncEngine({
      db: test.db,
      transport: {
        fetchConversations: base.fetchConversations,
        fetchMessages: base.fetchMessages,
        fetchMembers: (id) => {
          asked.push(id);
          return Promise.resolve([]);
        },
      },
    });

    await sync.runOnce();
    // Une passe complète ne demande la composition de personne : cinquante
    // fils, cinquante requêtes, pour une information qui bouge rarement.
    expect(asked).toEqual([]);

    await sync.syncConversation(CONV);
    expect(asked).toEqual([CONV]);
    test.close();
  });

  it('rapatrie les membres même quand aucun message n’a changé', async () => {
    const test = createTestDatabase();
    const server = new FakeServer();
    server.post(CONV, 'bonjour');

    const asked: string[] = [];
    const base = server.transport();
    const transport = {
      fetchConversations: base.fetchConversations,
      fetchMessages: base.fetchMessages,
      fetchMembers: (id: string) => {
        asked.push(id);
        return Promise.resolve([]);
      },
    };

    const sync = createSyncEngine({ db: test.db, transport });
    await sync.runOnce();
    asked.length = 0;

    // Le curseur est à jour : le raccourci « rien de neuf » s'applique. Un
    // membre ajouté ou retiré ne fait pourtant pas avancer `change_seq`, qui
    // ne compte que les écritures de messages — sauter la composition ici
    // afficherait éternellement une liste périmée.
    await sync.syncConversation(CONV);
    expect(asked).toEqual([CONV]);
    test.close();
  });
});
