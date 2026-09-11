import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';

import type { MessageRepository } from '@kola/core';

import { conversations, drafts, messages } from '../db/schema';
import { createClock, createIdGenerator, createTestDatabase } from '../db/testing';

import type { LocalDatabase } from './database';
import { createDraftRepository, type DraftRepository } from './drafts';
import { createMessageRepository } from './messages';
import { count as outboxCount } from './outbox';

/**
 * Un brouillon perdu parce que l'application a été fermée est une frustration
 * majeure — particulièrement ici, où l'on rédige souvent hors ligne pour
 * envoyer plus tard.
 */

const CONV = 'conv-1';
const OTHER = 'conv-2';
const ME = 'me';

describe('brouillons', () => {
  let db: LocalDatabase;
  let close: () => void;
  let repo: DraftRepository;
  let clock: ReturnType<typeof createClock>;

  beforeEach(() => {
    const test = createTestDatabase();
    db = test.db;
    close = test.close;
    clock = createClock();

    db.insert(conversations)
      .values([
        { id: CONV, type: 'group', title: 'Tontine', createdAt: clock.now() },
        { id: OTHER, type: 'group', title: 'Famille', createdAt: clock.now() },
      ])
      .run();

    repo = createDraftRepository({ db, now: clock.now });
    return () => close();
  });

  it('n’a rien à restaurer au départ', () => {
    expect(repo.get(CONV)).toBeNull();
  });

  it('enregistre et restitue un brouillon', () => {
    repo.save(CONV, 'Bonsoir, je passe demain');
    expect(repo.get(CONV)?.body).toBe('Bonsoir, je passe demain');
  });

  it('survit à un nouveau repository, donc à un redémarrage', () => {
    repo.save(CONV, 'texte abandonné');

    // L'application est tuée puis relancée : même base, nouvel objet.
    const afterRestart = createDraftRepository({ db, now: clock.now });
    expect(afterRestart.get(CONV)?.body).toBe('texte abandonné');
  });

  it('remplace au lieu d’empiler', () => {
    repo.save(CONV, 'première version');
    clock.advance(1000);
    repo.save(CONV, 'seconde version');

    expect(repo.list()).toHaveLength(1);
    expect(repo.get(CONV)?.body).toBe('seconde version');
  });

  it('garde un brouillon par conversation', () => {
    repo.save(CONV, 'ici');
    repo.save(OTHER, 'ailleurs');

    expect(repo.get(CONV)?.body).toBe('ici');
    expect(repo.get(OTHER)?.body).toBe('ailleurs');
  });

  it('efface plutôt que de conserver un brouillon vide', () => {
    // Sinon un champ vide réapparaîtrait comme s'il contenait quelque chose.
    repo.save(CONV, 'du texte');
    repo.save(CONV, '   ');

    expect(repo.get(CONV)).toBeNull();
  });

  it('conserve la réponse citée', () => {
    repo.save(CONV, 'ma réponse', 'msg-42');
    expect(repo.get(CONV)?.replyToId).toBe('msg-42');
  });

  it('horodate la dernière modification', () => {
    repo.save(CONV, 'v1');
    const first = repo.get(CONV)?.updatedAt;

    clock.advance(5000);
    repo.save(CONV, 'v2');

    expect(repo.get(CONV)?.updatedAt).toBe((first ?? 0) + 5000);
  });
});

describe('envoi depuis un brouillon', () => {
  let db: LocalDatabase;
  let close: () => void;
  let drafts_: DraftRepository;
  let messagesRepo: MessageRepository;
  let clock: ReturnType<typeof createClock>;

  beforeEach(() => {
    const test = createTestDatabase();
    db = test.db;
    close = test.close;
    clock = createClock();

    db.insert(conversations)
      .values({ id: CONV, type: 'group', title: 'Tontine', createdAt: clock.now() })
      .run();

    drafts_ = createDraftRepository({ db, now: clock.now });
    messagesRepo = createMessageRepository({
      db,
      now: clock.now,
      newId: createIdGenerator('msg'),
    });

    return () => close();
  });

  it('vide le brouillon en même temps qu’il envoie', async () => {
    drafts_.save(CONV, 'Bonsoir');

    await messagesRepo.sendMessage({
      conversationId: CONV,
      senderId: ME,
      body: 'Bonsoir',
      clearDraft: true,
    });

    // Critère d'acceptation de #31 : l'envoi vide le champ ET le brouillon
    // dans la même opération.
    expect(drafts_.get(CONV)).toBeNull();
    expect(db.select().from(messages).all()).toHaveLength(1);
    expect(outboxCount(db)).toBe(1);
  });

  it('conserve le brouillon quand l’envoi échoue', async () => {
    drafts_.save(CONV, 'Bonsoir');

    const fixedId = createMessageRepository({
      db,
      now: clock.now,
      newId: () => 'collision',
    });

    await fixedId.sendMessage({
      conversationId: CONV,
      senderId: ME,
      body: 'premier',
      clearDraft: false,
    });

    // Même clientId : la transaction échoue sur la clé primaire.
    await expect(
      fixedId.sendMessage({
        conversationId: CONV,
        senderId: ME,
        body: 'Bonsoir',
        clearDraft: true,
      }),
    ).rejects.toThrow();

    // Le brouillon survit : un plantage entre l'insertion et l'effacement
    // ferait perdre le texte de l'utilisateur.
    expect(drafts_.get(CONV)?.body).toBe('Bonsoir');
  });

  it('n’efface rien quand on ne le demande pas', async () => {
    drafts_.save(CONV, 'brouillon indépendant');

    await messagesRepo.sendMessage({
      conversationId: CONV,
      senderId: ME,
      body: 'autre message',
    });

    expect(drafts_.get(CONV)?.body).toBe('brouillon indépendant');
  });

  it('n’efface que le brouillon de la conversation concernée', async () => {
    db.insert(conversations)
      .values({ id: OTHER, type: 'group', title: 'Famille', createdAt: clock.now() })
      .run();

    drafts_.save(CONV, 'ici');
    drafts_.save(OTHER, 'ailleurs');

    await messagesRepo.sendMessage({
      conversationId: CONV,
      senderId: ME,
      body: 'ici',
      clearDraft: true,
    });

    expect(drafts_.get(CONV)).toBeNull();
    expect(drafts_.get(OTHER)?.body).toBe('ailleurs');
  });

  it('laisse le message en attente après envoi hors ligne', async () => {
    drafts_.save(CONV, 'écrit en mode avion');

    const message = await messagesRepo.sendMessage({
      conversationId: CONV,
      senderId: ME,
      body: 'écrit en mode avion',
      clearDraft: true,
    });

    expect(message.syncStatus).toBe('pending');
    expect(drafts_.get(CONV)).toBeNull();

    const row = db.select().from(drafts).where(eq(drafts.conversationId, CONV)).get();
    expect(row).toBeUndefined();
  });
});
