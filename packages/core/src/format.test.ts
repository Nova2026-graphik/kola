import { describe, expect, it } from 'vitest';

import {
  formatConversationTimestamp,
  formatDateSeparator,
  formatDuration,
  formatLastSeen,
  initialsOf,
  matchesSearch,
  normalizeForSearch,
} from './format';

/**
 * Les instants sont construits explicitement plutôt que dérivés de l'horloge :
 * un test de formatage de date qui passe le matin et échoue le soir ne sert à
 * rien.
 */
const NOW = new Date(2026, 8, 10, 14, 30, 0).getTime(); // jeudi 10 septembre 2026
const DAY = 24 * 60 * 60 * 1000;

describe('horodatage de la liste des conversations', () => {
  it('affiche l’heure pour aujourd’hui', () => {
    const at = new Date(2026, 8, 10, 9, 5, 0).getTime();
    expect(formatConversationTimestamp(at, NOW)).toBe('09:05');
  });

  it('affiche « Hier » pour la veille', () => {
    const at = new Date(2026, 8, 9, 22, 0, 0).getTime();
    expect(formatConversationTimestamp(at, NOW)).toBe('Hier');
  });

  it('affiche le jour dans la semaine écoulée', () => {
    const at = new Date(2026, 8, 7, 10, 0, 0).getTime(); // lundi
    expect(formatConversationTimestamp(at, NOW)).toBe('lundi');
  });

  it('affiche la date au-delà d’une semaine', () => {
    const at = new Date(2026, 7, 15, 10, 0, 0).getTime();
    expect(formatConversationTimestamp(at, NOW)).toBe('15/08');
  });

  it('ajoute l’année quand elle diffère', () => {
    const at = new Date(2025, 11, 24, 10, 0, 0).getTime();
    expect(formatConversationTimestamp(at, NOW)).toBe('24/12/2025');
  });

  it('traite minuit comme aujourd’hui, pas comme hier', () => {
    // Piège classique : un message de 00:05 ne doit pas s'afficher « Hier ».
    const at = new Date(2026, 8, 10, 0, 5, 0).getTime();
    expect(formatConversationTimestamp(at, NOW)).toBe('00:05');
  });

  it('traite 23:59 de la veille comme hier', () => {
    const at = new Date(2026, 8, 9, 23, 59, 0).getTime();
    expect(formatConversationTimestamp(at, NOW)).toBe('Hier');
  });

  it('respecte la langue', () => {
    const at = new Date(2026, 8, 9, 22, 0, 0).getTime();
    expect(formatConversationTimestamp(at, NOW, 'en')).toBe('Yesterday');
  });

  it('retombe sur le français pour une langue non traduite', () => {
    // L'éwé et le kabiyè n'ont pas encore de traduction (#63) : afficher de
    // l'anglais par accident serait pire que le français.
    const at = new Date(2026, 8, 9, 22, 0, 0).getTime();
    expect(formatConversationTimestamp(at, NOW, 'ee')).toBe('Hier');
  });
});

describe('séparateur de date', () => {
  it('nomme aujourd’hui et hier', () => {
    expect(formatDateSeparator(NOW, NOW)).toBe("Aujourd'hui");
    expect(formatDateSeparator(NOW - DAY, NOW)).toBe('Hier');
    expect(formatDateSeparator(NOW, NOW, 'en')).toBe('Today');
  });

  it('donne le jour dans la semaine, la date au-delà', () => {
    expect(formatDateSeparator(new Date(2026, 8, 7, 10, 0).getTime(), NOW)).toBe('lundi');
    expect(formatDateSeparator(new Date(2026, 7, 15, 10, 0).getTime(), NOW)).toBe('samedi 15/08');
  });
});

describe('durée', () => {
  it('formate en minutes et secondes', () => {
    expect(formatDuration(0)).toBe('0:00');
    expect(formatDuration(5_000)).toBe('0:05');
    expect(formatDuration(65_000)).toBe('1:05');
    expect(formatDuration(600_000)).toBe('10:00');
  });

  it('ne produit pas de durée négative', () => {
    expect(formatDuration(-1000)).toBe('0:00');
  });
});

describe('dernière connexion', () => {
  it('ne dit rien quand l’information manque', () => {
    // Mieux vaut ne rien afficher qu'un « vu il y a 56 ans ».
    expect(formatLastSeen(null, NOW)).toBeNull();
  });

  it('annonce la présence dans les deux dernières minutes', () => {
    expect(formatLastSeen(NOW - 30_000, NOW)).toBe('en ligne');
  });

  it('compte en minutes, puis en heures', () => {
    expect(formatLastSeen(NOW - 20 * 60_000, NOW)).toBe('vu il y a 20 min');
    expect(formatLastSeen(NOW - 5 * 60 * 60_000, NOW)).toBe('vu il y a 5 h');
  });

  it('bascule sur la date au-delà d’un jour', () => {
    expect(formatLastSeen(NOW - 2 * DAY, NOW)).toBe('vu le mardi');
  });
});

describe('initiales', () => {
  it('prend la première et la dernière', () => {
    expect(initialsOf('Kofi Mensah')).toBe('KM');
  });

  it('ignore les prénoms intermédiaires', () => {
    // Beaucoup de noms de la région en comptent plusieurs : trois lettres dans
    // un avatar rond deviennent illisibles.
    expect(initialsOf('Komlan Kwadzo Mawuli Adjovi')).toBe('KA');
  });

  it('gère un nom seul', () => {
    expect(initialsOf('Ama')).toBe('A');
  });

  it('gère les espaces multiples', () => {
    expect(initialsOf('  Yao   Lawson  ')).toBe('YL');
  });

  it('retombe sur un point d’interrogation', () => {
    // Cas réel : un profil créé par OTP SMS n'a pas encore de nom (#22).
    expect(initialsOf(null)).toBe('?');
    expect(initialsOf('')).toBe('?');
    expect(initialsOf('   ')).toBe('?');
  });
});

describe('recherche', () => {
  it('ignore les accents', () => {
    // Chercher « ete » doit trouver « été » : personne ne tape les accents sur
    // un clavier de téléphone.
    expect(normalizeForSearch('été')).toBe('ete');
    expect(matchesSearch('Réunion samedi', 'reunion')).toBe(true);
  });

  it('ignore la casse', () => {
    expect(matchesSearch('Tontine du quartier', 'TONTINE')).toBe(true);
  });

  it('trouve au milieu du texte', () => {
    expect(matchesSearch('Association des parents', 'parents')).toBe(true);
  });

  it('ne trouve pas ce qui n’y est pas', () => {
    expect(matchesSearch('Tontine du quartier', 'réunion')).toBe(false);
  });

  it('accepte tout sur une recherche vide', () => {
    expect(matchesSearch('quoi que ce soit', '')).toBe(true);
    expect(matchesSearch('quoi que ce soit', '   ')).toBe(true);
  });

  it('ne plante pas sur une valeur absente', () => {
    expect(matchesSearch(null, 'kofi')).toBe(false);
    expect(matchesSearch(undefined, '')).toBe(true);
  });
});
