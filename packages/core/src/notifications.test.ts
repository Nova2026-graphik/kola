import { describe, expect, it } from 'vitest';

import {
  doitDemander,
  ETAT_NOTIFICATIONS_INITIAL,
  jetonAChange,
  notificationsActives,
  type EtatNotifications,
} from './notifications';

/**
 * Le moment de la demande de permission.
 *
 * Sur iOS, un refus est quasi définitif : l'utilisateur doit aller le changer
 * dans les réglages du système, ce que presque personne ne fait. Demander au
 * mauvais moment ne se rattrape donc pas, et c'est précisément le genre
 * d'erreur qu'aucune remontée d'exception ne signalera jamais.
 */

function etat(overrides: Partial<EtatNotifications> = {}): EtatNotifications {
  return { ...ETAT_NOTIFICATIONS_INITIAL, ...overrides };
}

describe('moment de la demande de permission', () => {
  it('ne demande rien au premier lancement', () => {
    // L'application n'a encore rien fait pour l'utilisateur : la demande
    // arriverait comme une exigence, et le refus serait mérité.
    expect(doitDemander(etat(), 'premiere_conversation_ouverte')).toBe(false);
  });

  it('ne demande pas à la simple ouverture d’une conversation', () => {
    // On peut lire sans jamais écrire. Quelqu'un qui n'a pas participé n'a pas
    // de raison d'être notifié.
    expect(doitDemander(etat({ aEnvoyeUnMessage: true }), 'premiere_conversation_ouverte')).toBe(
      false,
    );
  });

  it('demande après le premier message envoyé', () => {
    expect(doitDemander(etat({ aEnvoyeUnMessage: true }), 'premier_message_envoye')).toBe(true);
  });

  it('ne demande pas avant qu’un message ait été envoyé', () => {
    expect(doitDemander(etat(), 'premier_message_envoye')).toBe(false);
  });

  it('ne redemande jamais automatiquement', () => {
    // Le système n'affiche sa boîte de dialogue qu'une fois : redemander
    // n'ouvrirait que les réglages, sans que l'utilisateur l'ait souhaité.
    const apres = etat({ aEnvoyeUnMessage: true, demandesFaites: 1, permission: 'refusee' });
    expect(doitDemander(apres, 'premier_message_envoye')).toBe(false);
  });

  it('redemande quand l’utilisateur le demande lui-même', () => {
    const refuse = etat({ permission: 'refusee', demandesFaites: 1 });
    expect(doitDemander(refuse, 'reglages')).toBe(true);
  });

  it('ne redemande pas depuis les réglages si c’est déjà accordé', () => {
    expect(doitDemander(etat({ permission: 'accordee' }), 'reglages')).toBe(false);
  });
});

describe('renouvellement du jeton', () => {
  it('détecte un jeton renouvelé par le système', () => {
    // Réinstallation, restauration de sauvegarde, mise à jour du système : sans
    // cette comparaison au démarrage, l'appareil garde un jeton mort et cesse
    // silencieusement de recevoir quoi que ce soit.
    expect(jetonAChange('ExponentPushToken[ancien]', 'ExponentPushToken[nouveau]')).toBe(true);
  });

  it('ne déclenche aucune écriture quand le jeton est inchangé', () => {
    expect(jetonAChange('ExponentPushToken[a]', 'ExponentPushToken[a]')).toBe(false);
  });

  it('traite la perte du jeton comme un changement', () => {
    // Permission révoquée dans les réglages : le serveur doit l'apprendre,
    // sinon il continuera d'envoyer vers un jeton mort.
    expect(jetonAChange('ExponentPushToken[a]', null)).toBe(true);
  });
});

describe('refus de permission', () => {
  it('n’empêche aucune autre fonctionnalité', () => {
    // Le critère d'acceptation de #57. Rien dans ce module ne conditionne quoi
    // que ce soit d'autre que l'affichage de l'état.
    expect(notificationsActives(etat({ permission: 'refusee' }))).toBe(false);
    expect(notificationsActives(etat({ permission: 'accordee' }))).toBe(true);
  });
});
