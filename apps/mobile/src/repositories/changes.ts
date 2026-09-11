import type { Unsubscribe } from '@kola/core';

/**
 * Notification des changements de la base locale.
 *
 * Ces émetteurs vivent ici, hors des repositories, pour une raison précise :
 * les repositories ne sont plus les seuls à écrire. La synchronisation delta
 * (#53) et le pont Realtime (#50) écrivent directement, et tant que
 * l'émetteur restait privé au repository, ces écritures étaient **invisibles
 * pour l'interface** — le message arrivait en base et l'écran ne bougeait pas
 * jusqu'au prochain rendu déclenché par autre chose.
 *
 * La règle est donc : qui écrit dans la base signale ce qu'il a écrit.
 */

class ChangeNotifier<K> {
  private readonly listeners = new Map<K, Set<() => void>>();

  subscribe(key: K, listener: () => void): Unsubscribe {
    const set = this.listeners.get(key) ?? new Set();
    set.add(listener);
    this.listeners.set(key, set);
    return () => {
      set.delete(listener);
      if (set.size === 0) {
        this.listeners.delete(key);
      }
    };
  }

  emit(key: K): void {
    for (const listener of this.listeners.get(key) ?? []) {
      listener();
    }
  }
}

/**
 * Changements sur les messages, granulaires par conversation.
 *
 * Sans cette granularité, chaque message reçu dans n'importe quel fil
 * re-rendrait tous les écrans ouverts.
 */
export const messageChanges = new ChangeNotifier<string>();

/** Changements sur la liste des conversations. Une seule clé : la liste entière. */
const CONVERSATION_LIST = 'conversations';

export const conversationChanges = {
  subscribe: (listener: () => void): Unsubscribe =>
    listChanges.subscribe(CONVERSATION_LIST, listener),
  emit: (): void => {
    listChanges.emit(CONVERSATION_LIST);
  },
};

const listChanges = new ChangeNotifier<string>();
