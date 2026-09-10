import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { MESSAGE_PAGE_SIZE, type MessageView } from '@kola/core';

import { useNow } from '../../hooks/useNow';
import { getRepositories } from '../../repositories';

import { buildFeed, initialScrollIndex, nextPageCursor, type FeedItem } from './grouping';

/**
 * Flux d'une conversation, paginé par curseur (#30).
 *
 * Deux règles héritées de l'ADR-0002 :
 *
 *   * la lecture est locale, toujours. Une conversation déjà synchronisée
 *     s'ouvre en mode avion sans différence perceptible ;
 *   * la pagination avance par `seq`, jamais par `offset`. Le volume transféré
 *     est proportionnel à ce qui manque, pas à la taille de l'historique.
 */

export interface UseMessageFeedOptions {
  readonly conversationId: string;
  readonly currentUserId: string | null;
  readonly lastReadSeq?: number | undefined;
}

export interface UseMessageFeedResult {
  readonly items: readonly FeedItem[];
  readonly isLoading: boolean;
  readonly hasMore: boolean;
  readonly initialIndex: number;
  /** Charge la page suivante. Sans effet si tout est déjà chargé. */
  readonly loadMore: () => void;
}

export function useMessageFeed(options: UseMessageFeedOptions): UseMessageFeedResult {
  const [messages, setMessages] = useState<readonly MessageView[] | null>(null);
  const [hasMore, setHasMore] = useState(true);

  // Une seule page en vol à la fois : le défilement peut déclencher plusieurs
  // demandes avant que la première n'aboutisse, et on chargerait deux fois la
  // même page.
  const loading = useRef(false);
  const now = useNow();

  const reload = useCallback(() => {
    void getRepositories()
      .messages.getMessages({ conversationId: options.conversationId })
      .then((page) => {
        setMessages(page);
        setHasMore(page.length >= MESSAGE_PAGE_SIZE);
      });
  }, [options.conversationId]);

  useEffect(() => {
    reload();
    // Granulaire par conversation : sans cela, chaque message reçu ailleurs
    // re-rendrait cet écran.
    return getRepositories().messages.subscribe(options.conversationId, reload);
  }, [options.conversationId, reload]);

  const loadMore = useCallback(() => {
    if (loading.current || !hasMore || messages === null) {
      return;
    }

    const cursor = nextPageCursor(messages);
    if (cursor === null) {
      // Rien de synchronisé : il n'y a pas d'historique plus ancien à chercher.
      setHasMore(false);
      return;
    }

    loading.current = true;
    void getRepositories()
      .messages.getMessages({ conversationId: options.conversationId, beforeSeq: cursor })
      .then((page) => {
        setMessages((current) => [...(current ?? []), ...page]);
        setHasMore(page.length >= MESSAGE_PAGE_SIZE);
      })
      .finally(() => {
        loading.current = false;
      });
  }, [hasMore, messages, options.conversationId]);

  const items = useMemo(() => {
    if (messages === null) {
      return [];
    }
    return buildFeed({
      messages,
      now,
      lastReadSeq: options.lastReadSeq,
      currentUserId: options.currentUserId ?? undefined,
    });
  }, [messages, now, options.lastReadSeq, options.currentUserId]);

  return {
    items,
    isLoading: messages === null,
    hasMore,
    initialIndex: initialScrollIndex(items),
    loadMore,
  };
}
