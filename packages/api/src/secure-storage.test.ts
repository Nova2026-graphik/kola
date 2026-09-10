import { beforeEach, describe, expect, it } from 'vitest';

import {
  createChunkedStorage,
  MAX_CHUNK_SIZE,
  splitIntoChunks,
  type ChunkedStorage,
  type KeyValueStore,
} from './secure-storage';

/**
 * Une session tronquée ne se voit pas tout de suite : elle se voit au
 * redémarrage suivant, quand l'utilisateur est déconnecté sans raison
 * apparente. Ces tests existent pour que cela n'arrive pas.
 */

/** Magasin en mémoire, avec la limite d'Android reproduite. */
function createFakeStore(limit = 2048): KeyValueStore & { readonly data: Map<string, string> } {
  const data = new Map<string, string>();
  const encoder = new TextEncoder();

  return {
    data,
    getItem: (key) => Promise.resolve(data.get(key) ?? null),
    setItem: (key, value) => {
      if (encoder.encode(value).length > limit) {
        // C'est exactement ce que fait expo-secure-store sur Android.
        return Promise.reject(new Error('valeur trop grande pour le stockage sécurisé'));
      }
      data.set(key, value);
      return Promise.resolve();
    },
    removeItem: (key) => {
      data.delete(key);
      return Promise.resolve();
    },
  };
}

describe('découpage', () => {
  it('ne découpe pas une valeur courte', () => {
    expect(splitIntoChunks('court')).toEqual(['court']);
  });

  it('découpe une valeur longue', () => {
    const value = 'a'.repeat(MAX_CHUNK_SIZE * 2 + 10);
    const chunks = splitIntoChunks(value);

    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.join('')).toBe(value);
  });

  it('respecte la taille en octets, pas en caractères', () => {
    const encoder = new TextEncoder();
    // Un caractère accentué occupe deux octets, un emoji jusqu'à quatre.
    const value = 'é'.repeat(2000);

    for (const chunk of splitIntoChunks(value, 100)) {
      expect(encoder.encode(chunk).length).toBeLessThanOrEqual(100);
    }
  });

  it('ne coupe jamais un caractère en deux', () => {
    // Un nom en éwé, un emoji, un caractère accentué : couper au milieu
    // produirait une chaîne invalide au recollage.
    const value = '👨‍👩‍👧‍👦é🇹🇬'.repeat(200);
    const chunks = splitIntoChunks(value, 64);

    expect(chunks.join('')).toBe(value);
    for (const chunk of chunks) {
      expect(chunk).not.toContain('�');
    }
  });

  it('gère une chaîne vide', () => {
    expect(splitIntoChunks('')).toEqual(['']);
  });
});

describe('stockage découpé', () => {
  let store: ReturnType<typeof createFakeStore>;
  let storage: ChunkedStorage;

  beforeEach(() => {
    store = createFakeStore();
    storage = createChunkedStorage(store);
  });

  it('lit et écrit une valeur courte sans découper', async () => {
    await storage.setItem('session', 'court');

    expect(await storage.getItem('session')).toBe('court');
    // Une seule entrée : aucun fragment inutile.
    expect(store.data.size).toBe(1);
  });

  it('stocke une session qui dépasse la limite d’Android', async () => {
    // Le cas réel : deux jetons JWT avec les métadonnées de l'utilisateur.
    const session = JSON.stringify({
      access_token: 'a'.repeat(1500),
      refresh_token: 'r'.repeat(1500),
      user: { id: 'u1', phone: '+22890123456' },
    });

    await storage.setItem('session', session);

    expect(await storage.getItem('session')).toBe(session);
  });

  it('rend null pour une clé absente', async () => {
    expect(await storage.getItem('inconnue')).toBeNull();
  });

  it('efface les fragments au retrait', async () => {
    await storage.setItem('session', 'x'.repeat(5000));
    expect(store.data.size).toBeGreaterThan(1);

    await storage.removeItem('session');

    // Rien ne doit subsister : un fragment oublié serait recollé par erreur.
    expect(store.data.size).toBe(0);
    expect(await storage.getItem('session')).toBeNull();
  });

  it('nettoie en passant d’une valeur longue à une valeur courte', async () => {
    await storage.setItem('session', 'x'.repeat(5000));
    await storage.setItem('session', 'court');

    expect(await storage.getItem('session')).toBe('court');
    expect(store.data.size).toBe(1);
  });

  it('nettoie en passant d’une valeur longue à une plus courte mais découpée', async () => {
    await storage.setItem('session', 'x'.repeat(8000));
    const before = store.data.size;

    await storage.setItem('session', 'y'.repeat(4000));

    expect(store.data.size).toBeLessThan(before);
    expect(await storage.getItem('session')).toBe('y'.repeat(4000));
  });

  it('rend null quand un fragment manque', async () => {
    await storage.setItem('session', 'x'.repeat(5000));
    // Simule une écriture interrompue ou une purge partielle du système.
    store.data.delete('session.1');

    // Une session absente force une reconnexion ; une session corrompue
    // échouerait plus loin, sans explication.
    expect(await storage.getItem('session')).toBeNull();
  });

  it('purge même sans en-tête', async () => {
    await storage.setItem('session', 'x'.repeat(5000));
    store.data.delete('session');

    await storage.clear('session');
    expect(store.data.size).toBe(0);
  });

  it('refuse une valeur démesurée plutôt que de la tronquer', async () => {
    await expect(storage.setItem('session', 'x'.repeat(MAX_CHUNK_SIZE * 30))).rejects.toThrow(
      /trop grande/,
    );
  });

  it('conserve le contenu exact, accents et emoji compris', async () => {
    const value = JSON.stringify({
      name: 'Komlan Kwadzo Mawuli',
      note: '🇹🇬 réunion à Lomé — 15 h',
      padding: 'x'.repeat(3000),
    });

    await storage.setItem('session', value);
    expect(await storage.getItem('session')).toBe(value);
  });
});
