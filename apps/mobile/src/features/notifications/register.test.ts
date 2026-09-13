import { describe, expect, it } from 'vitest';

import {
  ETAT_NOTIFICATIONS_INITIAL,
  type EtatNotifications,
  type PermissionNotification,
} from '@kola/core';

import {
  couperNotifications,
  demanderSiJustifie,
  synchroniserJeton,
  type DepotAppareil,
  type SystemeNotifications,
} from './register';

/**
 * Enregistrement du jeton push.
 *
 * Les défauts de ce module ne lèvent jamais d'exception. Un jeton non
 * renouvelé, une permission demandée trop tôt, un jeton laissé actif après
 * déconnexion : rien de tout cela ne casse quoi que ce soit de visible. Cela se
 * manifeste par des notifications qui n'arrivent pas — ou qui arrivent chez la
 * mauvaise personne.
 */

const APPAREIL = 'device-1';

function systeme(
  permission: PermissionNotification,
  jeton: string | null = 'ExponentPushToken[abc]',
): SystemeNotifications & { demandes: number } {
  const espion = {
    demandes: 0,
    lirePermission: () => Promise.resolve(permission),
    demanderPermission: () => {
      espion.demandes += 1;
      return Promise.resolve(permission === 'jamais_demandee' ? 'accordee' : permission);
    },
    obtenirJeton: () => Promise.resolve(jeton),
  };
  return espion as SystemeNotifications & { demandes: number };
}

function depot(connu: string | null = null) {
  const ecrits: (string | null)[] = [];
  let efface = false;
  const d: DepotAppareil = {
    lireJetonConnu: () => Promise.resolve(connu),
    enregistrer: (jeton) => {
      ecrits.push(jeton);
      return Promise.resolve();
    },
    effacerJeton: () => {
      efface = true;
      return Promise.resolve();
    },
  };
  return {
    depot: d,
    ecrits,
    efface: () => efface,
  };
}

function etat(overrides: Partial<EtatNotifications> = {}): EtatNotifications {
  return { ...ETAT_NOTIFICATIONS_INITIAL, ...overrides };
}

describe('synchronisation du jeton', () => {
  it('enregistre le jeton quand il est nouveau', async () => {
    const d = depot(null);
    const resultat = await synchroniserJeton({
      systeme: systeme('accordee'),
      depot: d.depot,
      deviceId: APPAREIL,
      etat: etat({ permission: 'accordee' }),
    });

    expect(resultat.ecrit).toBe(true);
    expect(d.ecrits).toEqual(['ExponentPushToken[abc]']);
  });

  it('n’écrit rien quand le jeton est inchangé', async () => {
    const d = depot('ExponentPushToken[abc]');
    const resultat = await synchroniserJeton({
      systeme: systeme('accordee'),
      depot: d.depot,
      deviceId: APPAREIL,
      etat: etat({ permission: 'accordee' }),
    });

    // Une écriture par démarrage, pour rien, sur un réseau facturé au
    // mégaoctet.
    expect(resultat.ecrit).toBe(false);
    expect(d.ecrits).toEqual([]);
  });

  it('efface le jeton serveur quand la permission a été révoquée', async () => {
    // Permission retirée depuis les réglages du système. Sans cette remontée,
    // le serveur enverrait indéfiniment vers un jeton mort en croyant notifier
    // quelqu'un.
    const d = depot('ExponentPushToken[ancien]');
    const resultat = await synchroniserJeton({
      systeme: systeme('refusee'),
      depot: d.depot,
      deviceId: APPAREIL,
      etat: etat({ permission: 'accordee' }),
    });

    expect(resultat.ecrit).toBe(true);
    expect(d.ecrits).toEqual([null]);
  });

  it('ne demande jamais la permission', async () => {
    // La synchronisation tourne à chaque démarrage : si elle demandait, la
    // demande arriverait à froid, exactement ce qu'on cherche à éviter.
    const s = systeme('jamais_demandee');
    await synchroniserJeton({
      systeme: s,
      depot: depot().depot,
      deviceId: APPAREIL,
      etat: etat(),
    });

    expect(s.demandes).toBe(0);
  });
});

describe('demande de permission', () => {
  it('ne demande pas avant qu’un message ait été envoyé', async () => {
    const s = systeme('jamais_demandee');
    const resultat = await demanderSiJustifie(
      { systeme: s, depot: depot().depot, deviceId: APPAREIL, etat: etat() },
      'premier_message_envoye',
    );

    expect(resultat.demandee).toBe(false);
    expect(s.demandes).toBe(0);
  });

  it('demande après le premier message, et enregistre dans la foulée', async () => {
    const s = systeme('jamais_demandee');
    const d = depot(null);
    const resultat = await demanderSiJustifie(
      {
        systeme: s,
        depot: d.depot,
        deviceId: APPAREIL,
        etat: etat({ aEnvoyeUnMessage: true }),
      },
      'premier_message_envoye',
    );

    expect(resultat.demandee).toBe(true);
    expect(resultat.etat.demandesFaites).toBe(1);
    expect(d.ecrits).toEqual(['ExponentPushToken[abc]']);
  });

  it('n’écrit rien après un refus', async () => {
    const d = depot(null);
    const resultat = await demanderSiJustifie(
      {
        systeme: systeme('refusee'),
        depot: d.depot,
        deviceId: APPAREIL,
        etat: etat({ aEnvoyeUnMessage: true }),
      },
      'premier_message_envoye',
    );

    // Le refus ne bloque aucune fonctionnalité : il ne fait qu'arrêter là.
    expect(resultat.demandee).toBe(true);
    expect(d.ecrits).toEqual([]);
  });

  it('ne redemande pas automatiquement après un refus', async () => {
    // Sur iOS, le système n'affiche plus sa boîte de dialogue : redemander
    // n'ouvrirait que les réglages, sans que l'utilisateur l'ait souhaité.
    const s = systeme('refusee');
    const resultat = await demanderSiJustifie(
      {
        systeme: s,
        depot: depot().depot,
        deviceId: APPAREIL,
        etat: etat({ aEnvoyeUnMessage: true, demandesFaites: 1, permission: 'refusee' }),
      },
      'premier_message_envoye',
    );

    expect(resultat.demandee).toBe(false);
    expect(s.demandes).toBe(0);
  });

  it('redemande quand l’utilisateur le demande depuis les réglages', async () => {
    const s = systeme('refusee');
    await demanderSiJustifie(
      {
        systeme: s,
        depot: depot().depot,
        deviceId: APPAREIL,
        etat: etat({ permission: 'refusee', demandesFaites: 1 }),
      },
      'reglages',
    );

    expect(s.demandes).toBe(1);
  });
});

describe('déconnexion', () => {
  it('efface le jeton côté serveur', async () => {
    // Sans cela, la personne suivante à se connecter sur ce téléphone
    // recevrait les notifications de la précédente.
    const d = depot('ExponentPushToken[abc]');
    await couperNotifications(d.depot);
    expect(d.efface()).toBe(true);
  });
});
