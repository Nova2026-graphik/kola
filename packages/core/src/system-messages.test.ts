import { describe, expect, it } from 'vitest';

import {
  formatSystemMessage,
  parseSystemMessage,
  SYSTEM_MESSAGE_FR,
  type SystemMessageBody,
} from './system-messages';

/**
 * Le contenu des messages système est du JSON typé, jamais une phrase.
 *
 * Ces tests protègent une décision irréversible : une phrase figée en base
 * resterait dans sa langue d'origine chez tout le monde, pour toujours, et
 * ajouter l'anglais ou l'éwé (#63) ne rattraperait aucun message déjà envoyé.
 */

const names: Record<string, string> = {
  'user-1': 'Amina',
  'user-2': 'Kodjo',
};

const resolve = (id: string | null): string =>
  id === null ? 'Quelqu’un' : (names[id] ?? 'Quelqu’un');

function render(body: SystemMessageBody, actor: string | null = 'user-1'): string {
  return formatSystemMessage(body, actor, resolve, SYSTEM_MESSAGE_FR);
}

describe('lecture d’un message système', () => {
  it('lit une création de groupe', () => {
    expect(parseSystemMessage('{"type":"group_created","title":"Tontine"}')).toEqual({
      type: 'group_created',
      title: 'Tontine',
    });
  });

  it('lit une arrivée', () => {
    expect(parseSystemMessage('{"type":"member_added","target":"user-2"}')).toEqual({
      type: 'member_added',
      target: 'user-2',
    });
  });

  it('accepte un type venu d’un serveur plus récent', () => {
    // Un téléphone jamais mis à jour depuis six mois doit continuer de
    // fonctionner, pas afficher du JSON brut ni tomber.
    expect(parseSystemMessage('{"type":"call_started","duration":42}')).toEqual({
      type: 'unknown',
    });
  });

  it('ne lève jamais sur un corps illisible', () => {
    // Un fil vide serait pire qu'une ligne discrète.
    for (const body of ['pas du json', '', '[]', 'null', '{"type":42}']) {
      expect(parseSystemMessage(body).type).toBe('unknown');
    }
    expect(parseSystemMessage(null).type).toBe('unknown');
  });

  it('refuse une arrivée sans cible', () => {
    // « a ajouté undefined » est pire que « Mise à jour du groupe ».
    expect(parseSystemMessage('{"type":"member_added"}').type).toBe('unknown');
  });
});

describe('rendu d’un message système', () => {
  it('rend chaque type en une phrase', () => {
    expect(render({ type: 'group_created', title: 'Tontine' })).toBe(
      'Amina a créé le groupe « Tontine »',
    );
    expect(render({ type: 'member_added', target: 'user-2' })).toBe('Amina a ajouté Kodjo');
    expect(render({ type: 'member_removed', target: 'user-2' })).toBe('Amina a retiré Kodjo');
    expect(render({ type: 'member_left' }, 'user-2')).toBe('Kodjo a quitté le groupe');
    expect(render({ type: 'title_changed', title: 'Tontine de Bè' })).toBe(
      'Amina a renommé le groupe en « Tontine de Bè »',
    );
    expect(render({ type: 'avatar_changed' })).toBe('Amina a changé la photo du groupe');
    expect(render({ type: 'role_changed', target: 'user-2', role: 'admin' })).toBe(
      'Amina a nommé Kodjo administrateur',
    );
  });

  it('reste lisible quand la personne est inconnue', () => {
    // Le profil peut n'être pas encore synchronisé, ou le compte supprimé (#25).
    expect(render({ type: 'member_added', target: 'inconnu' })).toBe('Amina a ajouté Quelqu’un');
    expect(render({ type: 'member_left' }, null)).toBe('Quelqu’un a quitté le groupe');
  });

  it('rend un type inconnu sans montrer sa mécanique', () => {
    expect(render({ type: 'unknown' })).toBe('Mise à jour du groupe');
  });

  it('n’écrit aucune phrase dans le corps stocké', () => {
    // La propriété qui protège #63 : le rendu est une fonction du corps, pas
    // le corps lui-même. Rien de traduit n'atteint la base.
    const body = parseSystemMessage('{"type":"member_added","target":"user-2"}');
    expect(JSON.stringify(body)).not.toContain('ajouté');
  });
});
