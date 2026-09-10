import { desc, eq, sql } from 'drizzle-orm';

import type { RemoteConversation, RemoteMember, RemoteMessage } from '@kola/core';

import { conversationMembers, conversations, messages, profiles, syncState } from '../db/schema';

import { conversationChanges, messageChanges } from './changes';
import type { LocalDatabase, Transaction } from './database';

/**
 * Écritures de la synchronisation entrante (#53).
 *
 * Tout ce fichier tient sur une seule règle, et c'est celle dont la violation
 * coûte le plus cher : **le curseur n'avance que dans la transaction qui écrit
 * la page**. L'avancer d'abord, ou après un `commit` séparé, perd les messages
 * de la page pour toujours — la coupure survient entre les deux, le curseur est
 * passé, et plus rien ne les redemandera. Le trou est silencieux et définitif.
 */

/** Un curseur, tel qu'il est conservé localement. */
export interface SyncCursor {
  readonly conversationId: string;
  readonly lastChangeSeq: number;
  readonly lastSyncedAt: number | null;
}

/** Une conversation à synchroniser, dans l'ordre où il faut le faire. */
export interface SyncTarget {
  readonly conversationId: string;
  readonly cursor: number;
  /** Ce que le serveur annonce. Égal au curseur : rien à récupérer. */
  readonly remoteChangeSeq: number;
}

export function readCursor(db: LocalDatabase, conversationId: string): SyncCursor {
  const row = db.select().from(syncState).where(eq(syncState.conversationId, conversationId)).get();

  return {
    conversationId,
    lastChangeSeq: row?.lastChangeSeq ?? 0,
    lastSyncedAt: row?.lastSyncedAt ?? null,
  };
}

/**
 * Remet un curseur à zéro.
 *
 * Un seul cas l'exige : le curseur local est en avance sur le compteur du
 * serveur. Cela n'arrive pas naturellement — un compteur ne recule pas — mais
 * une base restaurée depuis une sauvegarde produit exactement cet état, et le
 * client attendrait alors indéfiniment des lignes qui ne viendront jamais.
 */
export function resetCursor(db: LocalDatabase, conversationId: string, now: number): void {
  db.insert(syncState)
    .values({ conversationId, lastChangeSeq: 0, resetAt: now })
    .onConflictDoUpdate({
      target: syncState.conversationId,
      set: { lastChangeSeq: 0, resetAt: now },
    })
    .run();
}

/**
 * Applique une page de messages ET avance le curseur, atomiquement.
 *
 * Retourne le nombre de lignes écrites. Le curseur prend le `changeSeq` le plus
 * élevé de la page — pas `page.length`, la suite comporte des trous dès qu'un
 * message est modifié.
 */
export function applyMessagePage(
  db: LocalDatabase,
  conversationId: string,
  page: readonly RemoteMessage[],
  now: number,
): number {
  if (page.length === 0) {
    return 0;
  }

  const highest = page.reduce((max, message) => Math.max(max, message.changeSeq), 0);

  const written = db.transaction((tx) => {
    let count = 0;
    for (const message of page) {
      count += upsertMessage(tx, message);
    }

    tx.insert(syncState)
      .values({ conversationId, lastChangeSeq: highest, lastSyncedAt: now })
      .onConflictDoUpdate({
        target: syncState.conversationId,
        set: { lastChangeSeq: highest, lastSyncedAt: now },
      })
      .run();

    return count;
  });

  // Après la transaction, jamais dedans : un écouteur qui relit la base pendant
  // l'écriture verrait un état intermédiaire, et une lecture réentrante dans
  // une transaction synchrone est un piège sur `better-sqlite3`.
  messageChanges.emit(conversationId);
  conversationChanges.emit();
  return written;
}

/**
 * Écrit un message venu du serveur.
 *
 * La clé locale est le `clientId`, généré sur l'appareil avant tout aller-retour
 * réseau. Un message qu'on vient d'envoyer soi-même revient donc sur SA propre
 * ligne, au lieu d'en créer une seconde : c'est ce qui évite de voir ses propres
 * messages en double après une reconnexion.
 */
function upsertMessage(tx: Transaction, message: RemoteMessage): number {
  tx.insert(messages)
    .values({
      clientId: message.clientId,
      id: message.id,
      conversationId: message.conversationId,
      senderId: message.senderId,
      seq: message.seq,
      kind: message.kind,
      body: message.body,
      replyToId: message.replyToId,
      editedAt: message.editedAt,
      deletedAt: message.deletedAt,
      createdAt: message.createdAt,
      syncStatus: 'sent',
    })
    .onConflictDoUpdate({
      target: messages.clientId,
      set: {
        id: message.id,
        seq: message.seq,
        body: message.body,
        editedAt: message.editedAt,
        deletedAt: message.deletedAt,
        syncStatus: 'sent',
      },
      // `hiddenLocally` n'est jamais touché : « supprimer pour moi » est une
      // décision de cet appareil, que le serveur ignore et ne doit pas défaire.
    })
    .run();

  return 1;
}

/**
 * Écrit un message reçu en temps réel (#50).
 *
 * La différence avec `applyMessagePage` tient en une ligne absente : **le
 * curseur ne bouge pas**. Realtime ne garantit ni la livraison ni l'ordre, donc
 * recevoir l'écriture n° 47 ne prouve pas qu'on a reçu la 46. Avancer le
 * curseur à 47 condamnerait la 46 à ne jamais être demandée — un message perdu
 * définitivement, sans que rien ne le signale.
 *
 * La ligne sera donc écrite deux fois : ici, tout de suite, pour la latence ;
 * puis par la passe delta, sur la même clé, pour la garantie. La seconde
 * écriture est sans effet visible — c'est le prix, et il est modique.
 */
export function applyRealtimeMessage(db: LocalDatabase, message: RemoteMessage): void {
  db.transaction((tx) => {
    upsertMessage(tx, message);
  });

  messageChanges.emit(message.conversationId);
  conversationChanges.emit();
}

/**
 * Écrit la liste des conversations venue du serveur.
 *
 * Les colonnes purement locales — `lastOpenedAt`, `localOnly` — ne figurent pas
 * dans le `set` : elles n'ont pas d'équivalent côté serveur, et les écraser
 * ferait perdre à chaque passe l'ordre de priorité qu'on vient d'établir.
 */
export function applyConversations(
  db: LocalDatabase,
  remote: readonly RemoteConversation[],
): number {
  if (remote.length === 0) {
    return 0;
  }

  const count = db.transaction((tx) => {
    for (const conversation of remote) {
      tx.insert(conversations)
        .values({
          id: conversation.id,
          type: conversation.type,
          title: conversation.title,
          avatarUrl: conversation.avatarUrl,
          ownerId: conversation.ownerId,
          communityId: conversation.communityId,
          lastMessageAt: conversation.lastMessageAt,
          lastMessagePreview: conversation.lastMessagePreview,
          lastMessageSenderId: conversation.lastMessageSenderId,
          lastMessageKind: conversation.lastMessageKind,
          lastSeq: conversation.lastSeq,
          lastReadSeq: conversation.lastReadSeq,
          mutedUntil: conversation.mutedUntil,
          pinnedAt: conversation.pinnedAt,
          archivedAt: conversation.archivedAt,
          createdAt: conversation.createdAt,
          description: conversation.description,
          restricted: conversation.restricted,
          myRole: conversation.myRole,
          localOnly: false,
        })
        .onConflictDoUpdate({
          target: conversations.id,
          set: {
            type: conversation.type,
            title: conversation.title,
            avatarUrl: conversation.avatarUrl,
            ownerId: conversation.ownerId,
            communityId: conversation.communityId,
            lastMessageAt: conversation.lastMessageAt,
            lastMessagePreview: conversation.lastMessagePreview,
            lastMessageSenderId: conversation.lastMessageSenderId,
            lastMessageKind: conversation.lastMessageKind,
            lastSeq: conversation.lastSeq,
            description: conversation.description,
            restricted: conversation.restricted,
            myRole: conversation.myRole,
            mutedUntil: conversation.mutedUntil,
            pinnedAt: conversation.pinnedAt,
            archivedAt: conversation.archivedAt,
            localOnly: false,

            // `lastReadSeq` ne recule jamais. Un accusé posé hors ligne et pas
            // encore remonté est en avance sur le serveur : le reprendre tel
            // quel ferait réapparaître comme non lus des messages déjà vus.
            lastReadSeq: sql`max(${conversations.lastReadSeq}, ${conversation.lastReadSeq})`,
          },
        })
        .run();
    }
    return remote.length;
  });

  conversationChanges.emit();
  return count;
}

/**
 * Ordonne les conversations à synchroniser.
 *
 * Trois rangs, dans cet ordre : celles ouvertes récemment, puis celles qui ont
 * de l'activité récente, puis le reste. Sur un réseau lent, la première page
 * récupérée doit être celle que l'utilisateur regarde — pas celle qui vient en
 * premier dans un tri arbitraire.
 */
export function listSyncTargets(
  db: LocalDatabase,
  remote: readonly RemoteConversation[],
): readonly SyncTarget[] {
  const cursors = new Map(
    db
      .select()
      .from(syncState)
      .all()
      .map((row) => [row.conversationId, row.lastChangeSeq] as const),
  );

  const priority = new Map(
    db
      .select({ id: conversations.id, openedAt: conversations.lastOpenedAt })
      .from(conversations)
      .all()
      .map((row) => [row.id, row.openedAt ?? 0] as const),
  );

  return [...remote]
    .map((conversation) => ({
      conversationId: conversation.id,
      cursor: cursors.get(conversation.id) ?? 0,
      remoteChangeSeq: conversation.lastChangeSeq,
      openedAt: priority.get(conversation.id) ?? 0,
      activeAt: conversation.lastMessageAt ?? 0,
    }))
    .sort((a, b) => b.openedAt - a.openedAt || b.activeAt - a.activeAt)
    .map(({ conversationId, cursor, remoteChangeSeq }) => ({
      conversationId,
      cursor,
      remoteChangeSeq,
    }));
}

/** Note qu'une conversation vient d'être ouverte. Sert au tri ci-dessus. */
export function markConversationOpened(
  db: LocalDatabase,
  conversationId: string,
  now: number,
): void {
  db.update(conversations)
    .set({ lastOpenedAt: now })
    .where(eq(conversations.id, conversationId))
    .run();
}

/** Date de la dernière synchronisation réussie, tous fils confondus. */
export function lastSyncedAt(db: LocalDatabase): number | null {
  const row = db
    .select({ at: syncState.lastSyncedAt })
    .from(syncState)
    .where(sql`${syncState.lastSyncedAt} is not null`)
    .orderBy(desc(syncState.lastSyncedAt))
    .limit(1)
    .get();

  return row?.at ?? null;
}

/**
 * Écrit la composition d'une conversation venue du serveur (#38).
 *
 * Remplacement complet plutôt que fusion : un membre parti côté serveur doit
 * disparaître ici, et une fusion ne saurait pas le distinguer d'un membre
 * simplement absent de la page. La liste est courte par nature — un groupe, pas
 * un annuaire — donc le remplacement ne coûte rien.
 *
 * Les profils sont écrits au passage : sans eux, l'écran d'infos afficherait
 * une liste d'identifiants.
 */
export function applyMembers(
  db: LocalDatabase,
  conversationId: string,
  remote: readonly RemoteMember[],
): number {
  db.transaction((tx) => {
    tx.delete(conversationMembers)
      .where(eq(conversationMembers.conversationId, conversationId))
      .run();

    for (const member of remote) {
      tx.insert(conversationMembers)
        .values({
          conversationId,
          userId: member.userId,
          role: member.role,
          joinedAt: member.joinedAt,
        })
        .onConflictDoNothing()
        .run();

      tx.insert(profiles)
        .values({
          id: member.userId,
          username: member.username,
          displayName: member.displayName,
          avatarUrl: member.avatarUrl,
        })
        .onConflictDoUpdate({
          target: profiles.id,
          set: {
            username: member.username,
            displayName: member.displayName,
            avatarUrl: member.avatarUrl,
          },
        })
        .run();
    }
  });

  conversationChanges.emit();
  return remote.length;
}
