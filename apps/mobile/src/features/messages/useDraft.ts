import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState } from 'react-native';

import { getRepositories } from '../../repositories';

/**
 * Brouillon d'une conversation, avec écriture temporisée (#31).
 *
 * Deux contraintes opposées à concilier :
 *
 *   * écrire à chaque frappe saturerait SQLite — sur un appareil d'entrée de
 *     gamme, cela se voit dans la latence du clavier ;
 *   * ne pas écrire assez souvent perd le texte au moment où l'utilisateur en
 *     a le plus besoin, c'est-à-dire quand l'application est tuée.
 *
 * D'où une temporisation courte, **plus une écriture forcée** dès que
 * l'application passe en arrière-plan : c'est le seul instant où le système
 * prévient avant de tuer le processus.
 */

export const DRAFT_DEBOUNCE_MS = 500;

export interface UseDraftResult {
  readonly value: string;
  readonly setValue: (next: string) => void;
  /** Écrit immédiatement, sans attendre la temporisation. */
  readonly flush: () => void;
  /** Oublie le brouillon, après un envoi réussi. */
  readonly reset: () => void;
}

export function useDraft(conversationId: string): UseDraftResult {
  // Lecture synchrone au premier rendu : SQLite est local, et le champ doit
  // être rempli avant que l'utilisateur ne voie l'écran.
  const [value, setValueState] = useState<string>(
    () => getRepositories().drafts.get(conversationId)?.body ?? '',
  );

  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const latest = useRef(value);

  const persist = useCallback(() => {
    if (timer.current !== null) {
      clearTimeout(timer.current);
      timer.current = null;
    }
    getRepositories().drafts.save(conversationId, latest.current);
  }, [conversationId]);

  const setValue = useCallback(
    (next: string) => {
      latest.current = next;
      setValueState(next);

      if (timer.current !== null) {
        clearTimeout(timer.current);
      }
      timer.current = setTimeout(persist, DRAFT_DEBOUNCE_MS);
    },
    [persist],
  );

  const reset = useCallback(() => {
    if (timer.current !== null) {
      clearTimeout(timer.current);
      timer.current = null;
    }
    latest.current = '';
    setValueState('');
    // Le brouillon a déjà été effacé dans la transaction d'envoi : rien à
    // écrire ici, seulement l'état local à remettre à zéro.
  }, []);

  // Écriture forcée quand l'application quitte le premier plan. C'est le
  // dernier moment où l'on est prévenu.
  useEffect(() => {
    const subscription = AppState.addEventListener('change', (state) => {
      if (state !== 'active') {
        persist();
      }
    });

    return () => {
      subscription.remove();
      // Quitter l'écran est aussi une raison d'écrire : la temporisation en
      // cours n'aura pas le temps d'aboutir.
      persist();
    };
  }, [persist]);

  return { value, setValue, flush: persist, reset };
}
