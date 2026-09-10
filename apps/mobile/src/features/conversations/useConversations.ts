import { useCallback, useEffect, useMemo, useState } from 'react';

import type { ConversationView } from '@kola/core';

import { useNow } from '../../hooks/useNow';
import { getRepositories } from '../../repositories';

import { buildConversationRows, type ConversationRow, type ProfileSummary } from './rows';

/**
 * Données de la liste des conversations (#29).
 *
 * Lecture locale uniquement : aucune requête réseau n'est déclenchée ici. La
 * liste doit s'afficher en moins de 500 ms au démarrage, réseau ou pas
 * (ADR-0006).
 */

export interface UseConversationsOptions {
  readonly currentUserId: string;
  readonly profiles: ReadonlyMap<string, ProfileSummary>;
  readonly search?: string | undefined;
}

export interface UseConversationsResult {
  readonly rows: readonly ConversationRow[];
  readonly isLoading: boolean;
  readonly isEmpty: boolean;
  readonly refresh: () => void;
}

export function useConversations(options: UseConversationsOptions): UseConversationsResult {
  const [conversations, setConversations] = useState<readonly ConversationView[] | null>(null);
  // Instant stable, rafraîchi chaque minute : le rendu reste pur, et « 14:29 »
  // devient « Hier » au passage de minuit sans quitter l'écran.
  const now = useNow();

  const load = useCallback(() => {
    void getRepositories().conversations.listConversations().then(setConversations);
  }, []);

  useEffect(() => {
    load();
    // Le repository notifie à chaque écriture locale : la liste se rafraîchit
    // sans que l'écran ait à interroger quoi que ce soit.
    return getRepositories().conversations.subscribe(load);
  }, [load]);

  const rows = useMemo(() => {
    if (conversations === null) {
      return [];
    }
    return buildConversationRows({
      conversations,
      profiles: options.profiles,
      currentUserId: options.currentUserId,
      now,
      search: options.search,
    });
  }, [conversations, now, options.profiles, options.currentUserId, options.search]);

  return {
    rows,
    isLoading: conversations === null,
    isEmpty: conversations !== null && conversations.length === 0,
    refresh: load,
  };
}
