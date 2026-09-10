import { describe, expect, it } from 'vitest';

import type { ConversationView } from '@kola/core';

import { buildConversationRows, isMuted, totalUnread, type ProfileSummary } from './rows';

const NOW = new Date(2026, 8, 10, 14, 30, 0).getTime();
const ME = 'me';
const KOFI = 'kofi';

function conversation(overrides: Partial<ConversationView> = {}): ConversationView {
  return {
    id: 'c1',
    type: 'group',
    title: 'Tontine du quartier',
    avatarUrl: null,
    lastMessageAt: NOW - 60_000,
    lastMessagePreview: 'Réunion samedi',
    lastMessageSenderId: KOFI,
    lastMessageKind: 'text',
    lastSeq: 10,
    lastReadSeq: 10,
    unreadCount: 0,
    mutedUntil: null,
    pinnedAt: null,
    archivedAt: null,
    description: null,
    restricted: false,
    myRole: 'member',
    ...overrides,
  };
}

const PROFILES = new Map<string, ProfileSummary>([
  [ME, { id: ME, displayName: 'Moi', username: 'moi', avatarUrl: null }],
  [KOFI, { id: KOFI, displayName: 'Kofi Mensah', username: 'kofi', avatarUrl: null }],
  ['nameless', { id: 'nameless', displayName: null, username: null, avatarUrl: null }],
  ['pseudo', { id: 'pseudo', displayName: null, username: 'sena', avatarUrl: null }],
]);

function build(conversations: ConversationView[], extra = {}) {
  return buildConversationRows({
    conversations,
    profiles: PROFILES,
    currentUserId: ME,
    now: NOW,
    ...extra,
  });
}

describe('titre affiché', () => {
  it('prend le titre du groupe', () => {
    expect(build([conversation()])[0]?.title).toBe('Tontine du quartier');
  });

  it('prend le nom du contact pour une conversation directe', () => {
    // Un DM n'a pas de titre : il faut le déduire de l'autre participant.
    const row = build([conversation({ type: 'dm', title: null })])[0];
    expect(row?.title).toBe('Kofi Mensah');
  });

  it('retombe sur le pseudo quand le nom manque', () => {
    const row = build([
      conversation({ type: 'dm', title: null, lastMessageSenderId: 'pseudo' }),
    ])[0];
    expect(row?.title).toBe('@sena');
  });

  it('affiche un libellé lisible quand le profil est vide', () => {
    // Cas réel : un compte créé par OTP SMS n'a pas encore de nom (#22).
    // Afficher « null » serait pire que tout.
    const row = build([
      conversation({ type: 'dm', title: null, lastMessageSenderId: 'nameless' }),
    ])[0];
    expect(row?.title).toBe('Sans nom');
  });

  it('calcule des initiales pour l’avatar de repli', () => {
    expect(build([conversation({ type: 'dm', title: null })])[0]?.initials).toBe('KM');
  });
});

describe('aperçu', () => {
  it('préfixe par l’auteur dans un groupe', () => {
    // Savoir qui a parlé compte autant que ce qui a été dit.
    expect(build([conversation()])[0]?.preview).toBe('Kofi Mensah : Réunion samedi');
  });

  it('dit « Vous » pour ses propres messages', () => {
    const row = build([conversation({ lastMessageSenderId: ME })])[0];
    expect(row?.preview).toBe('Vous : Réunion samedi');
  });

  it('ne préfixe pas dans une conversation directe', () => {
    const row = build([conversation({ type: 'dm', title: null })])[0];
    expect(row?.preview).toBe('Réunion samedi');
  });

  it('nomme le type de média à la place du texte', () => {
    const row = build([
      conversation({ type: 'dm', title: null, lastMessagePreview: null, lastMessageKind: 'audio' }),
    ])[0];
    expect(row?.preview).toBe('Message vocal');
  });

  it('annonce un message supprimé plutôt qu’un aperçu vide', () => {
    // Sinon la conversation paraîtrait n'avoir jamais rien contenu, alors
    // qu'elle porte un horodatage.
    const row = build([
      conversation({ type: 'dm', title: null, lastMessagePreview: null, lastMessageKind: 'text' }),
    ])[0];
    expect(row?.preview).toBe('Message supprimé');
  });

  it('reste vide pour une conversation sans aucun message', () => {
    const row = build([
      conversation({ lastMessageAt: null, lastMessagePreview: null, lastMessageSenderId: null }),
    ])[0];
    expect(row?.preview).toBe('');
    expect(row?.timestamp).toBe('');
  });
});

describe('sourdine', () => {
  it('reconnaît une sourdine active', () => {
    expect(isMuted(conversation({ mutedUntil: NOW + 3_600_000 }), NOW)).toBe(true);
  });

  it('ignore une sourdine expirée', () => {
    // Une sourdine à échéance n'en est plus une : l'oublier laisserait des
    // conversations muettes pour toujours.
    expect(isMuted(conversation({ mutedUntil: NOW - 1 }), NOW)).toBe(false);
  });

  it('conserve le compte de non-lus malgré la sourdine', () => {
    // L'utilisateur veut savoir combien il a manqué ; il veut juste ne pas
    // être dérangé.
    const row = build([conversation({ unreadCount: 12, mutedUntil: NOW + 1000 })])[0];
    expect(row?.unreadCount).toBe(12);
    expect(row?.isMuted).toBe(true);
  });
});

describe('badge global', () => {
  it('additionne les non-lus', () => {
    const total = totalUnread(
      [conversation({ unreadCount: 3 }), conversation({ id: 'c2', unreadCount: 4 })],
      NOW,
    );
    expect(total).toBe(7);
  });

  it('exclut les conversations en sourdine', () => {
    // Le badge sert à décider s'il faut ouvrir l'application : une conversation
    // qu'on a fait taire ne doit pas peser sur cette décision.
    const total = totalUnread(
      [
        conversation({ unreadCount: 3 }),
        conversation({ id: 'c2', unreadCount: 40, mutedUntil: NOW + 1000 }),
      ],
      NOW,
    );
    expect(total).toBe(3);
  });

  it('vaut zéro sans conversation', () => {
    expect(totalUnread([], NOW)).toBe(0);
  });
});

describe('recherche', () => {
  it('filtre sur le titre affiché', () => {
    const rows = build(
      [conversation(), conversation({ id: 'c2', title: 'Association des parents' })],
      { search: 'tontine' },
    );
    expect(rows.map((r) => r.title)).toEqual(['Tontine du quartier']);
  });

  it('ignore les accents et la casse', () => {
    const rows = build([conversation({ title: 'Réunion mensuelle' })], { search: 'REUNION' });
    expect(rows).toHaveLength(1);
  });

  it('trouve une conversation directe par le nom du contact', () => {
    // C'est le cas qui compte : le titre n'existe pas en base, il est calculé.
    const rows = build([conversation({ type: 'dm', title: null })], { search: 'mensah' });
    expect(rows).toHaveLength(1);
  });

  it('ne rend rien quand rien ne correspond', () => {
    expect(build([conversation()], { search: 'introuvable' })).toHaveLength(0);
  });

  it('rend tout sur une recherche vide', () => {
    expect(build([conversation(), conversation({ id: 'c2' })], { search: '' })).toHaveLength(2);
  });
});

describe('divers', () => {
  it('signale les conversations épinglées', () => {
    expect(build([conversation({ pinnedAt: NOW })])[0]?.isPinned).toBe(true);
    expect(build([conversation()])[0]?.isPinned).toBe(false);
  });

  it('remonte l’état du dernier message envoyé par soi', () => {
    const rows = build([conversation()], {
      ownStatuses: new Map([['c1', 'pending']]),
    });
    expect(rows[0]?.ownMessageStatus).toBe('pending');
  });

  it('n’affiche aucun état quand le dernier message vient d’un autre', () => {
    expect(build([conversation()])[0]?.ownMessageStatus).toBeNull();
  });

  it('formate l’horodatage', () => {
    expect(build([conversation({ lastMessageAt: NOW - 60_000 })])[0]?.timestamp).toBe('14:29');
  });

  it('respecte la langue', () => {
    const row = build([conversation({ lastMessageSenderId: ME })], { locale: 'en' })[0];
    expect(row?.preview).toBe('You : Réunion samedi');
  });
});
