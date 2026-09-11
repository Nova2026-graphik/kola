/**
 * Stockage de session découpé (#23).
 *
 * `expo-secure-store` est limité à **2048 octets par entrée sur Android**, et
 * échoue au-delà — parfois silencieusement selon les versions. Or une session
 * Supabase contient deux jetons JWT, dont l'un porte les métadonnées de
 * l'utilisateur : elle dépasse régulièrement cette limite.
 *
 * Une session tronquée ne se voit pas tout de suite. Elle se voit au
 * redémarrage suivant, quand l'utilisateur est déconnecté sans raison
 * apparente. D'où ce découpage explicite plutôt qu'un espoir.
 *
 * Le module ne dépend d'aucune API native : il reçoit un magasin clé-valeur,
 * ce qui le rend testable sous Node.
 */

/** Marge sous la limite d'Android, pour la clé et l'encodage. */
export const MAX_CHUNK_SIZE = 1800;

/** Nombre maximal de fragments. Au-delà, la donnée n'a rien à faire ici. */
export const MAX_CHUNKS = 20;

export interface KeyValueStore {
  readonly getItem: (key: string) => Promise<string | null>;
  readonly setItem: (key: string, value: string) => Promise<void>;
  readonly removeItem: (key: string) => Promise<void>;
}

/** En-tête écrit sous la clé principale quand la valeur est découpée. */
const CHUNK_MARKER = '__kola_chunks__:';

function chunkKey(key: string, index: number): string {
  return `${key}.${String(index)}`;
}

/**
 * Découpe une chaîne en fragments d'au plus `MAX_CHUNK_SIZE` **octets**.
 *
 * Le découpage se fait sur les octets, pas sur les caractères : un nom
 * d'utilisateur en éwé ou un emoji occupe plusieurs octets en UTF-8, et
 * couper au milieu produirait une chaîne invalide.
 */
export function splitIntoChunks(value: string, size: number = MAX_CHUNK_SIZE): string[] {
  const encoder = new TextEncoder();
  if (encoder.encode(value).length <= size) {
    return [value];
  }

  const chunks: string[] = [];
  let current = '';
  let currentBytes = 0;

  // Itération par point de code : `for...of` sur une chaîne ne coupe jamais une
  // paire de substitution en deux.
  for (const char of value) {
    const charBytes = encoder.encode(char).length;

    if (currentBytes + charBytes > size && current !== '') {
      chunks.push(current);
      current = '';
      currentBytes = 0;
    }

    current += char;
    currentBytes += charBytes;
  }

  if (current !== '') {
    chunks.push(current);
  }

  return chunks;
}

export interface ChunkedStorage extends KeyValueStore {
  readonly clear: (key: string) => Promise<void>;
}

export function createChunkedStorage(store: KeyValueStore): ChunkedStorage {
  async function removeChunks(key: string, count: number): Promise<void> {
    for (let index = 0; index < count; index += 1) {
      await store.removeItem(chunkKey(key, index));
    }
  }

  /** Nombre de fragments annoncé sous la clé principale, ou null. */
  function parseMarker(raw: string | null): number | null {
    if (raw === null || !raw.startsWith(CHUNK_MARKER)) {
      return null;
    }
    const count = Number.parseInt(raw.slice(CHUNK_MARKER.length), 10);
    return Number.isInteger(count) && count > 0 ? count : null;
  }

  return {
    getItem: async (key: string) => {
      const head = await store.getItem(key);
      const count = parseMarker(head);

      if (count === null) {
        return head;
      }

      const parts: string[] = [];
      for (let index = 0; index < count; index += 1) {
        const part = await store.getItem(chunkKey(key, index));
        if (part === null) {
          // Un fragment manquant rend l'ensemble inutilisable. Mieux vaut une
          // session absente — donc une reconnexion — qu'une session corrompue
          // qui échouerait plus loin, sans explication.
          return null;
        }
        parts.push(part);
      }

      return parts.join('');
    },

    setItem: async (key: string, value: string) => {
      // Toujours nettoyer d'abord : passer d'une valeur découpée à une valeur
      // courte laisserait des fragments orphelins, qu'une lecture ultérieure
      // pourrait recoller par erreur.
      const previous = parseMarker(await store.getItem(key));
      if (previous !== null) {
        await removeChunks(key, previous);
      }

      const chunks = splitIntoChunks(value);

      if (chunks.length === 1) {
        await store.setItem(key, value);
        return;
      }

      if (chunks.length > MAX_CHUNKS) {
        throw new Error(
          `valeur trop grande pour le stockage sécurisé : ${String(chunks.length)} fragments`,
        );
      }

      for (const [index, chunk] of chunks.entries()) {
        await store.setItem(chunkKey(key, index), chunk);
      }
      // L'en-tête s'écrit en DERNIER : si l'écriture est interrompue, la clé
      // principale ne pointe pas vers des fragments incomplets.
      await store.setItem(key, `${CHUNK_MARKER}${String(chunks.length)}`);
    },

    removeItem: async (key: string) => {
      const count = parseMarker(await store.getItem(key));
      if (count !== null) {
        await removeChunks(key, count);
      }
      await store.removeItem(key);
    },

    clear: async (key: string) => {
      // Purge défensive : retire les fragments même si l'en-tête a disparu.
      await removeChunks(key, MAX_CHUNKS);
      await store.removeItem(key);
    },
  };
}
