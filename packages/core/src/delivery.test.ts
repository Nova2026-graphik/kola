import { describe, expect, it } from 'vitest';

import {
  deliveryLabel,
  deliveryStateOf,
  isRetryable,
  pendingSummary,
  type DeliveryInput,
} from './delivery';

function input(overrides: Partial<DeliveryInput> = {}): DeliveryInput {
  return { syncStatus: 'sent', serverId: 'srv-1', ...overrides };
}

describe('état d’acheminement', () => {
  it('reste « en attente » tant que rien n’est parti', () => {
    expect(deliveryStateOf(input({ syncStatus: 'pending', serverId: null }))).toBe('pending');
  });

  it('ne prétend jamais « envoyé » sans identifiant serveur', () => {
    // Le garde-fou contre l'affichage optimiste qui mentirait : c'est le
    // serveur qui décide qu'un message est parti, pas le client.
    expect(deliveryStateOf(input({ syncStatus: 'sent', serverId: null }))).toBe('pending');
  });

  it('passe à « envoyé » quand le serveur a répondu', () => {
    expect(deliveryStateOf(input())).toBe('sent');
  });

  it('passe à « reçu » puis « lu »', () => {
    expect(deliveryStateOf(input({ deliveredCount: 1 }))).toBe('delivered');
    expect(deliveryStateOf(input({ deliveredCount: 3, readCount: 1 }))).toBe('read');
  });

  it('privilégie l’information la plus avancée', () => {
    // Un message peut être « sent » côté file et déjà lu côté accusés.
    expect(deliveryStateOf(input({ readCount: 2, deliveredCount: 2 }))).toBe('read');
  });

  it('signale l’échec avant tout le reste', () => {
    expect(deliveryStateOf(input({ syncStatus: 'failed', serverId: 'srv-1', readCount: 5 }))).toBe(
      'failed',
    );
  });

  it('ignore des compteurs à zéro', () => {
    expect(deliveryStateOf(input({ deliveredCount: 0, readCount: 0 }))).toBe('sent');
  });

  it('n’autorise la relance que sur un échec', () => {
    expect(isRetryable('failed')).toBe(true);
    for (const state of ['pending', 'sent', 'delivered', 'read'] as const) {
      expect(isRetryable(state)).toBe(false);
    }
  });
});

describe('libellés d’accessibilité', () => {
  it('distingue clairement « en attente » et « envoyé »', () => {
    // C'est la confusion la plus coûteuse : on range son téléphone en croyant
    // avoir prévenu quelqu'un.
    expect(deliveryLabel('pending')).toBe('en attente d’envoi');
    expect(deliveryLabel('sent')).toBe('envoyé');
    expect(deliveryLabel('pending')).not.toBe(deliveryLabel('sent'));
  });

  it('couvre les cinq états dans les deux langues', () => {
    for (const state of ['pending', 'sent', 'delivered', 'read', 'failed'] as const) {
      expect(deliveryLabel(state, 'fr').length).toBeGreaterThan(0);
      expect(deliveryLabel(state, 'en').length).toBeGreaterThan(0);
    }
  });

  it('invite à agir sur un échec', () => {
    expect(deliveryLabel('failed')).toContain('réessayer');
  });
});

describe('bandeau récapitulatif', () => {
  it('ne dit rien quand tout est parti', () => {
    // Un bandeau permanent devient invisible.
    expect(pendingSummary(0, 0)).toBeNull();
  });

  it('annonce les messages en attente sans dramatiser', () => {
    // C'est un état normal du produit, pas une erreur.
    expect(pendingSummary(1, 0)).toBe('1 message en attente du réseau');
    expect(pendingSummary(4, 0)).toBe('4 messages en attente du réseau');
  });

  it('donne la priorité aux échecs', () => {
    // Un échec demande une action ; une attente, non.
    expect(pendingSummary(5, 2)).toBe('2 messages non envoyés');
    expect(pendingSummary(0, 1)).toBe('1 message non envoyé');
  });

  it('accorde correctement au singulier', () => {
    expect(pendingSummary(1, 0)).not.toContain('messages');
    expect(pendingSummary(0, 1)).not.toContain('envoyés');
  });

  it('traduit en anglais', () => {
    expect(pendingSummary(2, 0, 'en')).toBe('2 messages waiting for the network');
    expect(pendingSummary(0, 1, 'en')).toBe('1 message not sent');
  });
});
