import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';

import {
  realtimeRetryDelay,
  REALTIME_RETRY_CAP_MS,
  type RealtimeHandlers,
  type RealtimeSubscriber,
  type RemoteMessage,
} from '@kola/core';

import { messages, syncState } from '../db/schema';
import { createClock, createTestDatabase } from '../db/testing';
import type { LocalDatabase } from '../repositories/database';
import { applyMessagePage } from '../repositories/sync';

import { createRealtimeBridge } from './realtime';

/**
 * Tests du pont Realtime.
 *
 * Le test qui compte est le premier : **un événement temps réel ne doit pas
 * faire avancer le curseur de synchronisation**. C'est contre-intuitif — on
 * vient de recevoir le message, pourquoi ne pas noter qu'on l'a ? — et c'est
 * pourtant la différence entre une messagerie fiable et une messagerie qui perd
 * un message sur cent sans que personne ne sache pourquoi.
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

/** Faux abonnement : il expose les rappels pour qu'on les déclenche à la main. */
class FakeSubscriber implements RealtimeSubscriber {
  handlers: RealtimeHandlers | null = null;
  openedFor: string | null = null;
  closes = 0;

  subscribe = (conversationId: string, handlers: RealtimeHandlers): (() => void) => {
    this.openedFor = conversationId;
    this.handlers = handlers;
    return () => {
      this.closes += 1;
      this.handlers = null;
      this.openedFor = null;
    };
  };
}

describe('pont Realtime', () => {
  let db: LocalDatabase;
  let clock: ReturnType<typeof createClock>;
  let subscriber: FakeSubscriber;
  let resync: (conversationId: string) => void;
  let resyncCalls: string[];

  beforeEach(() => {
    const test = createTestDatabase();
    db = test.db;
    clock = createClock();
    subscriber = new FakeSubscriber();
    resyncCalls = [];
    resync = (conversationId: string) => resyncCalls.push(conversationId);
    return () => {
      test.close();
    };
  });

  function bridge() {
    return createRealtimeBridge({ db, subscriber, resync });
  }

  it('n’avance jamais le curseur de synchronisation', () => {
    // La passe delta en est à l'écriture n° 3.
    applyMessagePage(db, CONV, [remoteMessage({ changeSeq: 3 })], clock.now());
    expect(db.select().from(syncState).get()?.lastChangeSeq).toBe(3);

    bridge().open(CONV);
    // Realtime livre la 47 sans avoir livré la 46 : rien ne l'interdit, aucune
    // garantie d'ordre ni de livraison n'existe sur ce canal.
    subscriber.handlers?.onMessage(
      remoteMessage({ id: 'srv-47', clientId: 'cli-47', seq: 47, changeSeq: 47 }),
    );

    // Le message est bien en base…
    expect(db.select().from(messages).where(eq(messages.clientId, 'cli-47')).get()).toBeDefined();
    // …mais le curseur n'a pas bougé. L'avancer à 47 condamnerait la 46 à ne
    // jamais être demandée : un message perdu définitivement, sans trace.
    expect(db.select().from(syncState).get()?.lastChangeSeq).toBe(3);
  });

  it('écrit l’événement en base avant de notifier l’interface', () => {
    const seen: string[] = [];
    const withCallback = createRealtimeBridge({
      db,
      subscriber,
      resync,
      onApplied: () => {
        // Au moment où l'interface est prévenue, la ligne doit déjà exister :
        // sinon un message reçu en temps réel s'afficherait sans être en base
        // et disparaîtrait au redémarrage.
        const row = db.select().from(messages).get();
        seen.push(row?.body ?? 'ABSENT');
      },
    });

    withCallback.open(CONV);
    subscriber.handlers?.onMessage(remoteMessage({ body: 'salut' }));

    expect(seen).toEqual(['salut']);
  });

  it('ne duplique pas l’écho de son propre message', () => {
    // Le message est parti d'ici : il existe déjà localement sous son clientId.
    db.insert(messages)
      .values({
        clientId: 'cli-1',
        conversationId: CONV,
        body: 'bonjour',
        syncStatus: 'pending',
        createdAt: clock.now(),
      })
      .run();

    bridge().open(CONV);
    subscriber.handlers?.onMessage(remoteMessage());

    const rows = db.select().from(messages).all();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.id).toBe('srv-1');
    expect(rows[0]?.syncStatus).toBe('sent');
  });

  it('applique une suppression arrivée en temps réel', () => {
    bridge().open(CONV);
    subscriber.handlers?.onMessage(remoteMessage());
    subscriber.handlers?.onMessage(
      remoteMessage({ changeSeq: 2, body: null, deletedAt: clock.now() }),
    );

    const row = db.select().from(messages).get();
    expect(row?.body).toBeNull();
    expect(row?.deletedAt).not.toBeNull();
  });

  it('rattrape par curseur à chaque connexion', () => {
    bridge().open(CONV);

    subscriber.handlers?.onConnected();
    expect(resyncCalls).toEqual([CONV]);

    // Reconnexion après coupure : ce qui s'est passé pendant n'a été livré à
    // personne. Le rattrapage n'a pas d'exception.
    subscriber.handlers?.onConnected();
    expect(resyncCalls).toEqual([CONV, CONV]);
  });

  it('ferme le canal précédent en changeant de conversation', () => {
    const pont = bridge();
    pont.open(CONV);
    pont.open('conv-2');

    // Cinquante canaux ouverts épuiseraient batterie et forfait.
    expect(subscriber.closes).toBe(1);
    expect(subscriber.openedFor).toBe('conv-2');
    expect(pont.current()).toBe('conv-2');
  });

  it('ne rouvre pas le canal de la conversation déjà suivie', () => {
    const pont = bridge();
    pont.open(CONV);
    pont.open(CONV);

    expect(subscriber.closes).toBe(0);
  });

  it('ferme tout à la fermeture', () => {
    const pont = bridge();
    pont.open(CONV);
    pont.close();

    expect(subscriber.closes).toBe(1);
    expect(pont.current()).toBeNull();
  });

  it('signale une écriture impossible sans se rompre', () => {
    const errors: unknown[] = [];
    const broken = new Proxy(db, {
      get: (target, property, receiver) =>
        property === 'transaction'
          ? () => {
              throw new Error('base verrouillée');
            }
          : Reflect.get(target, property, receiver),
    }) as LocalDatabase;

    const pont = createRealtimeBridge({
      db: broken,
      subscriber,
      resync,
      onError: (error) => errors.push(error),
    });
    pont.open(CONV);
    subscriber.handlers?.onMessage(remoteMessage());

    // Ce n'est pas grave : le curseur n'a pas dépassé la ligne, donc la passe
    // delta la rattrapera. Ce qui serait grave, c'est de rompre le canal.
    expect(errors).toHaveLength(1);
    expect(subscriber.handlers).not.toBeNull();
  });
});

describe('temporisation de reconnexion', () => {
  it('croît puis plafonne', () => {
    const noJitter = () => 0;

    expect(realtimeRetryDelay(1, noJitter)).toBe(1_000);
    expect(realtimeRetryDelay(2, noJitter)).toBe(2_000);
    expect(realtimeRetryDelay(3, noJitter)).toBe(4_000);

    // Sur réseau instable, une reconnexion en boucle consomme plus que le
    // trafic utile. Le plafond compte autant que la croissance.
    expect(realtimeRetryDelay(30, noJitter)).toBe(REALTIME_RETRY_CAP_MS);
  });

  it('ne dépasse jamais le plafond, quelle que soit la part d’aléatoire', () => {
    for (const random of [0, 0.5, 0.999]) {
      expect(realtimeRetryDelay(50, () => random)).toBeLessThanOrEqual(REALTIME_RETRY_CAP_MS);
    }
  });

  it('disperse les reconnexions', () => {
    // Sans cela, tous les appareils d'une même coupure reviennent à la même
    // seconde et refont tomber le serveur qu'ils viennent de retrouver.
    expect(realtimeRetryDelay(5, () => 0)).not.toBe(realtimeRetryDelay(5, () => 1));
  });
});
