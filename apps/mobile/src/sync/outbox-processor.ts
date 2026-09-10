import { and, eq, sql } from 'drizzle-orm';

import {
  DuplicateMessageError,
  EMPTY_RUN_REPORT,
  TransportError,
  type DeleteMessagePayload,
  type EditMessagePayload,
  type MarkReadPayload,
  type OutboxItem,
  type OutboxRunReport,
  type AddMembersPayload,
  type ConversationPrefsPayload,
  type CreateGroupPayload,
  type LeaveGroupPayload,
  type MemberPayload,
  type OutboxTransport,
  type SetMemberRolePayload,
  type UpdateGroupPayload,
  type ReactionPayload,
  type SendMessagePayload,
  type SendMessageResult,
} from '@kola/core';

import {
  conversationMembers,
  conversations,
  drafts,
  messages,
  outbox,
  syncState,
} from '../db/schema';
import type { LocalDatabase } from '../repositories/database';
import { dequeue, pending, recordFailure } from '../repositories/outbox';

/**
 * Moteur de vidage de la file d'attente sortante.
 *
 * C'est ce qui transforme « le message est écrit localement » en « le message
 * est parti ». Trois garanties, chacune testée :
 *
 *   * **l'ordre est préservé par conversation.** Vingt messages écrits hors
 *     ligne partent dans l'ordre où ils ont été écrits. Dès qu'une entrée
 *     échoue, sa conversation est mise de côté pour la passe en cours : sinon
 *     le message suivant partirait avant celui qui a échoué, et arriverait
 *     dans le désordre chez le destinataire ;
 *
 *   * **une seule passe à la fois.** Deux passes concurrentes enverraient les
 *     mêmes entrées deux fois ;
 *
 *   * **un doublon côté serveur est un succès.** Si le serveur répond que le
 *     `client_id` existe déjà, c'est que le message était bien parti et que
 *     seule la réponse s'est perdue — le cas typique d'une coupure juste après
 *     l'envoi.
 */

export interface OutboxProcessorOptions {
  readonly db: LocalDatabase;
  readonly transport: OutboxTransport;
  readonly now?: () => number;
  readonly random?: () => number;
  /** Notifié après chaque passe ayant modifié quelque chose. */
  readonly onChange?: (report: OutboxRunReport) => void;
  /** Nombre maximal d'entrées traitées par passe. */
  readonly batchSize?: number;
}

export interface OutboxProcessor {
  /** Vide la file une fois. Ne fait rien si une passe est déjà en cours. */
  readonly runOnce: () => Promise<OutboxRunReport>;
  /** Vrai tant qu'une passe est en cours. */
  readonly isRunning: () => boolean;
}

export function createOutboxProcessor(options: OutboxProcessorOptions): OutboxProcessor {
  const { db, transport } = options;
  const now = options.now ?? (() => Date.now());
  const random = options.random ?? Math.random;
  const batchSize = options.batchSize ?? 50;

  let running = false;

  /** Applique au message local ce que le serveur lui a attribué. */
  function markMessageSent(clientId: string, result: SendMessageResult): void {
    db.update(messages)
      .set({ id: result.id, seq: result.seq, syncStatus: 'sent' })
      .where(eq(messages.clientId, clientId))
      .run();
  }

  function markMessageFailed(clientId: string): void {
    db.update(messages).set({ syncStatus: 'failed' }).where(eq(messages.clientId, clientId)).run();
  }

  function markMessageSynced(clientId: string): void {
    db.update(messages).set({ syncStatus: 'sent' }).where(eq(messages.clientId, clientId)).run();
  }

  /** Exécute une entrée. Lève en cas d'échec, pour que l'appelant décide. */
  async function dispatch(item: OutboxItem): Promise<void> {
    switch (item.operation) {
      case 'send_message': {
        const payload = item.payload as SendMessagePayload;
        try {
          const result = await transport.sendMessage(payload);
          markMessageSent(payload.clientId, result);
        } catch (error) {
          if (error instanceof DuplicateMessageError) {
            // L'idempotence a fonctionné : le message était parti, seule la
            // réponse s'était perdue. On adopte ce que le serveur a retenu.
            markMessageSent(payload.clientId, error.existing);
            return;
          }
          throw error;
        }
        return;
      }

      case 'edit_message': {
        const payload = item.payload as EditMessagePayload;
        await transport.editMessage(payload);
        markMessageSynced(payload.clientId);
        return;
      }

      case 'delete_message': {
        const payload = item.payload as DeleteMessagePayload;
        await transport.deleteMessage(payload);
        markMessageSynced(payload.clientId);
        return;
      }

      case 'create_group': {
        const payload = item.payload as CreateGroupPayload;
        const result = await transport.createGroup(payload);
        adoptServerGroupId(payload.clientId, result.id);
        return;
      }

      case 'update_group': {
        await transport.updateGroup(item.payload as UpdateGroupPayload);
        return;
      }

      case 'add_members': {
        await transport.addMembers(item.payload as AddMembersPayload);
        return;
      }

      case 'remove_member': {
        const payload = item.payload as MemberPayload;
        await transport.removeMember(payload);
        // Le serveur a confirmé : la ligne marquée peut vraiment partir. La
        // supprimer avant la confirmation l'aurait fait réapparaître à la
        // synchronisation suivante si le serveur avait refusé.
        db.delete(conversationMembers)
          .where(
            and(
              eq(conversationMembers.conversationId, payload.conversationId),
              eq(conversationMembers.userId, payload.userId),
            ),
          )
          .run();
        return;
      }

      case 'set_member_role': {
        await transport.setMemberRole(item.payload as SetMemberRolePayload);
        return;
      }

      case 'transfer_ownership': {
        await transport.transferOwnership(item.payload as MemberPayload);
        return;
      }

      case 'leave_group': {
        await transport.leaveGroup(item.payload as LeaveGroupPayload);
        return;
      }

      case 'set_conversation_prefs': {
        await transport.setConversationPrefs(item.payload as ConversationPrefsPayload);
        return;
      }

      case 'mark_read': {
        await transport.markRead(item.payload as MarkReadPayload);
        return;
      }

      case 'add_reaction': {
        await transport.addReaction(item.payload as ReactionPayload);
        return;
      }

      case 'remove_reaction': {
        await transport.removeReaction(item.payload as ReactionPayload);
        return;
      }

      default: {
        // Une opération inconnue vient forcément d'une version antérieure de
        // l'application : elle ne partira jamais, autant l'abandonner tout de
        // suite plutôt que de bloquer la file indéfiniment.
        throw new TransportError(`opération inconnue : ${String(item.operation)}`, 400);
      }
    }
  }

  /**
   * Filet de sécurité : le serveur a rendu un autre identifiant que le nôtre.
   *
   * Il n'est pas censé le faire — `create_group` adopte l'identifiant fourni
   * par l'appareil, précisément pour que ce cas n'existe pas (migration
   * 20260910120014). Mais s'il arrivait, laisser les deux identités coexister
   * produirait un groupe fantôme : un fil visible sans messages, à côté de
   * messages rattachés à une conversation disparue.
   *
   * Tout ce qui porte l'identifiant doit suivre, y compris les charges utiles
   * encore en file — un `send_message` qui garderait l'ancien identifiant
   * serait rejeté par la clé étrangère, définitivement.
   */
  function adoptServerGroupId(localId: string, serverId: string): void {
    if (localId === serverId) {
      return;
    }
    db.transaction((tx) => {
      tx.update(conversations)
        .set({ id: serverId, localOnly: false })
        .where(eq(conversations.id, localId))
        .run();
      tx.update(messages)
        .set({ conversationId: serverId })
        .where(eq(messages.conversationId, localId))
        .run();
      tx.update(drafts)
        .set({ conversationId: serverId })
        .where(eq(drafts.conversationId, localId))
        .run();
      tx.update(syncState)
        .set({ conversationId: serverId })
        .where(eq(syncState.conversationId, localId))
        .run();
      tx.run(
        sql`update ${outbox}
               set conversation_id = ${serverId},
                   payload = case
                     when json_extract(payload, '$.conversationId') is not null
                       then json_set(payload, '$.conversationId', ${serverId})
                     else payload
                   end
             where conversation_id = ${localId}`,
      );
    });
  }

  /** Le message porté par une entrée, s'il y en a un. */
  function messageClientIdOf(item: OutboxItem): string | null {
    switch (item.operation) {
      case 'send_message':
      case 'edit_message':
      case 'delete_message':
        return (item.payload as { clientId?: string }).clientId ?? null;
      default:
        return null;
    }
  }

  async function runOnce(): Promise<OutboxRunReport> {
    if (running) {
      // Deux passes concurrentes enverraient les mêmes entrées deux fois.
      return EMPTY_RUN_REPORT;
    }
    running = true;

    let sent = 0;
    let deferred = 0;
    let abandoned = 0;
    let blocked = 0;

    /**
     * Conversations mises de côté pour cette passe.
     *
     * Une entrée sans conversation (un accusé global, par exemple) est isolée
     * sous une clé qui ne peut entrer en collision avec un identifiant réel.
     */
    const stalled = new Set<string>();
    const NO_CONVERSATION = ' sans-conversation';

    try {
      const batch = pending(db, now(), batchSize);

      for (const item of batch) {
        const conversationKey = item.conversationId ?? NO_CONVERSATION;

        if (stalled.has(conversationKey)) {
          // Une entrée précédente de cette conversation a échoué : envoyer
          // celle-ci la ferait arriver avant, dans le désordre.
          blocked += 1;
          continue;
        }

        try {
          await dispatch(item);
          dequeue(db, item.operation, item.entityId);
          sent += 1;
        } catch (error) {
          const status = error instanceof TransportError ? error.status : null;
          const message = error instanceof Error ? error.message : String(error);

          const outcome = recordFailure(db, item, { status, message }, now(), random);

          if (outcome.abandoned) {
            abandoned += 1;
            const clientId = messageClientIdOf(item);
            if (clientId) {
              // L'utilisateur voit « échec » et peut relancer à la main (#32).
              markMessageFailed(clientId);
            }
          } else {
            deferred += 1;
          }

          stalled.add(conversationKey);
        }
      }
    } finally {
      running = false;
    }

    const report: OutboxRunReport = { sent, deferred, abandoned, blocked };

    if (sent > 0 || deferred > 0 || abandoned > 0) {
      options.onChange?.(report);
    }

    return report;
  }

  return {
    runOnce,
    isRunning: () => running,
  };
}
