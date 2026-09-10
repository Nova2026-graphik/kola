import { useCallback, useEffect, useState } from 'react';

import { can, type ConversationView, type MemberView, type Permission } from '@kola/core';

import { getRepositories } from '../../repositories';
import { conversationChanges } from '../../repositories/changes';

/**
 * État de l'écran d'informations d'un groupe (#38).
 *
 * Lecture strictement locale : l'écran doit s'ouvrir hors ligne, comme le reste
 * (ADR-0002). La composition arrive par la synchronisation, déclenchée à
 * l'ouverture du fil.
 */

export interface GroupInfo {
  readonly conversation: ConversationView | null;
  readonly members: readonly MemberView[];
  readonly isLoading: boolean;
  /**
   * Ce que l'utilisateur peut faire, d'après son rôle.
   *
   * Sert à ne pas proposer une action vouée à l'échec. Ne constitue jamais la
   * sécurité : elle est portée par RLS et les triggers (#14, #39), et un appel
   * direct à l'API s'y heurte de la même façon.
   */
  readonly allows: (permission: Permission) => boolean;
  readonly refresh: () => void;
}

export function useGroupInfo(conversationId: string): GroupInfo {
  const [conversation, setConversation] = useState<ConversationView | null>(null);
  const [members, setMembers] = useState<readonly MemberView[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  const load = useCallback(() => {
    const repositories = getRepositories();
    void Promise.all([
      repositories.conversations.getConversation(conversationId),
      repositories.conversations.listMembers(conversationId),
    ]).then(([found, list]) => {
      setConversation(found);
      setMembers(list);
      setIsLoading(false);
    });
  }, [conversationId]);

  useEffect(() => {
    load();
    // Toute écriture locale — la nôtre comme celle de la synchronisation —
    // repasse par cet émetteur (#50, #53). Sans abonnement, un membre ajouté
    // par quelqu'un d'autre n'apparaîtrait qu'à la réouverture de l'écran.
    return conversationChanges.subscribe(load);
  }, [load]);

  const allows = useCallback(
    (permission: Permission): boolean =>
      conversation === null
        ? false
        : can({ role: conversation.myRole, restricted: conversation.restricted }, permission),
    [conversation],
  );

  return { conversation, members, isLoading, allows, refresh: load };
}
