import {
  EMPTY_SYNC_REPORT,
  SYNC_PAGE_SIZE,
  type RemoteConversation,
  type SyncReport,
  type SyncTransport,
} from '@kola/core';

import type { LocalDatabase } from '../repositories/database';
import {
  applyConversations,
  applyMessagePage,
  listSyncTargets,
  resetCursor,
  type SyncTarget,
} from '../repositories/sync';

/**
 * Moteur de synchronisation delta (#53).
 *
 * C'est ce qui rend Kola utilisable après trois jours sans réseau. La reprise
 * est un `where change_seq > curseur`, jamais un rechargement : sur un forfait
 * facturé au mégaoctet, retélécharger l'historique à chaque reconnexion serait
 * rédhibitoire, et l'utilisateur cesserait simplement de se reconnecter.
 *
 * Quatre propriétés, chacune testée :
 *
 *   * **le curseur n'avance qu'après écriture locale**, dans la même
 *     transaction. C'est la seule protection contre la perte définitive d'une
 *     page : coupure entre l'écriture et l'avancement, et plus rien ne
 *     redemandera ces messages ;
 *
 *   * **une passe interrompue reprend où elle s'était arrêtée.** Il n'y a pas
 *     d'état en mémoire à reconstruire : le curseur en base suffit ;
 *
 *   * **l'échec d'une conversation n'arrête pas les autres.** Un fil dont le
 *     serveur refuse la lecture ne doit pas priver l'utilisateur du reste ;
 *
 *   * **le volume transféré est proportionnel à ce qui manque**, pas à la
 *     taille de l'historique.
 */

export interface SyncEngineOptions {
  readonly db: LocalDatabase;
  readonly transport: SyncTransport;
  readonly now?: () => number;
  readonly pageSize?: number;
  /**
   * Garde-fou : nombre maximal de pages par conversation et par passe. Un
   * appareil très en retard reprendra à la passe suivante plutôt que de tenir
   * le processeur — et la batterie — jusqu'à épuisement.
   */
  readonly maxPagesPerConversation?: number;
  /** Notifié à chaque changement d'état, pour l'indicateur discret de l'interface. */
  readonly onStateChange?: (state: SyncEngineState) => void;
  /** Notifié après chaque passe ayant écrit quelque chose. */
  readonly onChange?: (report: SyncReport) => void;
}

export type SyncPhase = 'idle' | 'conversations' | 'messages';

export interface SyncEngineState {
  readonly phase: SyncPhase;
  /** Conversation en cours de rattrapage, s'il y en a une. */
  readonly conversationId: string | null;
  /** Conversations restant à traiter dans la passe en cours. */
  readonly remaining: number;
}

export interface SyncEngine {
  /** Effectue une passe complète. Ne fait rien si une passe est déjà en cours. */
  readonly runOnce: () => Promise<SyncReport>;
  /** Rattrape une seule conversation — à l'ouverture de son écran. */
  readonly syncConversation: (conversationId: string) => Promise<SyncReport>;
  readonly isRunning: () => boolean;
  readonly getState: () => SyncEngineState;
  /**
   * Demande l'arrêt de la passe en cours. Elle s'arrête entre deux pages, une
   * fois la page courante écrite : jamais au milieu d'une transaction.
   */
  readonly cancel: () => void;
}

const IDLE: SyncEngineState = { phase: 'idle', conversationId: null, remaining: 0 };

export function createSyncEngine(options: SyncEngineOptions): SyncEngine {
  const { db, transport } = options;
  const now = options.now ?? (() => Date.now());
  const pageSize = options.pageSize ?? SYNC_PAGE_SIZE;
  const maxPages = options.maxPagesPerConversation ?? 50;

  let running = false;
  let cancelled = false;
  let state: SyncEngineState = IDLE;

  function setState(next: SyncEngineState): void {
    state = next;
    options.onStateChange?.(next);
  }

  /**
   * Rattrape une conversation, page après page.
   *
   * Ne lève jamais : elle rapporte l'échec ET le travail déjà accompli. La
   * distinction n'est pas cosmétique — une passe interrompue après dix pages a
   * bel et bien écrit ces dix pages, et un rapport qui l'ignorerait ferait
   * croire à une régression là où il n'y a qu'une coupure.
   */
  async function drain(
    target: SyncTarget,
  ): Promise<{ messages: number; pages: number; failed: boolean }> {
    let cursor = target.cursor;
    let written = 0;
    let pages = 0;

    while (pages < maxPages && !cancelled) {
      let page;
      try {
        page = await transport.fetchMessages({
          conversationId: target.conversationId,
          afterChangeSeq: cursor,
          limit: pageSize,
        });
      } catch {
        // Coupure réseau. Le curseur est resté sur la dernière page écrite :
        // la passe suivante reprendra exactement là.
        return { messages: written, pages, failed: true };
      }

      if (page.length === 0) {
        break;
      }

      const highest = page.reduce((max, message) => Math.max(max, message.changeSeq), 0);
      if (highest <= cursor) {
        // Le serveur renvoie des lignes que le curseur a déjà dépassées : la
        // page n'est pas triée, ou le filtre n'a pas été appliqué. Continuer
        // redemanderait la même page indéfiniment. On s'arrête plutôt que de
        // tourner en rond sur le forfait de l'utilisateur.
        break;
      }

      try {
        // Écriture et avancement du curseur dans la MÊME transaction.
        written += applyMessagePage(db, target.conversationId, page, now());
      } catch {
        // Écriture locale impossible — disque plein, base verrouillée. Le
        // curseur n'a PAS bougé, donc rien n'est perdu : la page sera
        // redemandée. C'est exactement ce que l'ordre « écrire puis avancer »
        // achète.
        return { messages: written, pages, failed: true };
      }

      cursor = highest;
      pages += 1;

      // Une page incomplète signifie qu'on a rattrapé le serveur.
      if (page.length < pageSize) {
        break;
      }
    }

    return { messages: written, pages, failed: false };
  }

  /**
   * Détecte un curseur incohérent.
   *
   * Un compteur ne recule pas : un curseur local en avance sur celui du serveur
   * ne s'explique que par une base restaurée depuis une sauvegarde. Sans ce
   * contrôle, le client attendrait indéfiniment des lignes qui ne viendront
   * jamais, et son fil resterait figé sans que rien ne le signale.
   */
  function needsReset(target: SyncTarget): boolean {
    return target.cursor > target.remoteChangeSeq;
  }

  async function runPass(only?: string): Promise<SyncReport> {
    let messagesWritten = 0;
    let pages = 0;
    let failed = 0;
    let reset = 0;

    setState({ phase: 'conversations', conversationId: null, remaining: 0 });

    let remote: readonly RemoteConversation[];
    try {
      remote = await transport.fetchConversations();
    } catch {
      // Sans la liste, on ne sait pas quoi rattraper. Ce n'est pas grave : la
      // base locale reste lisible, et la passe suivante réessaiera (ADR-0002).
      setState(IDLE);
      return { ...EMPTY_SYNC_REPORT, failed: 1 };
    }

    let conversationsWritten: number;
    try {
      conversationsWritten = applyConversations(db, remote);
    } catch {
      // La base locale refuse d'écrire. Rien d'autre ne peut aboutir dans
      // cette passe, mais elle doit se terminer proprement : une exception qui
      // remonte jusqu'à l'appelant laisserait l'indicateur bloqué et, sur un
      // déclenchement automatique, produirait un rejet non traité.
      setState(IDLE);
      return { ...EMPTY_SYNC_REPORT, failed: 1 };
    }

    const targets = listSyncTargets(db, remote).filter(
      (target) => only === undefined || target.conversationId === only,
    );

    let index = 0;
    for (const target of targets) {
      if (cancelled) {
        break;
      }
      index += 1;
      setState({
        phase: 'messages',
        conversationId: target.conversationId,
        remaining: targets.length - index,
      });

      let effective = target;
      if (needsReset(target)) {
        resetCursor(db, target.conversationId, now());
        effective = { ...target, cursor: 0 };
        reset += 1;
      } else if (target.cursor >= target.remoteChangeSeq) {
        // Rien de neuf : le serveur n'a rien écrit depuis la dernière passe.
        // Ne pas demander la page évite un aller-retour par conversation et par
        // passe, ce qui compte quand on en a cinquante.
        continue;
      }

      const result = await drain(effective);
      messagesWritten += result.messages;
      pages += result.pages;
      if (result.failed) {
        // Un fil qui échoue ne doit pas priver l'utilisateur des autres.
        failed += 1;
      }
    }

    setState(IDLE);

    const report: SyncReport = {
      conversations: conversationsWritten,
      messages: messagesWritten,
      pages,
      failed,
      reset,
    };

    if (messagesWritten > 0 || conversationsWritten > 0) {
      options.onChange?.(report);
    }
    return report;
  }

  async function guarded(only?: string): Promise<SyncReport> {
    // Deux passes concurrentes liraient le même curseur et récupéreraient deux
    // fois les mêmes pages — le double du volume pour rien.
    if (running) {
      return EMPTY_SYNC_REPORT;
    }
    running = true;
    cancelled = false;
    try {
      return await runPass(only);
    } finally {
      running = false;
      setState(IDLE);
    }
  }

  return {
    runOnce: () => guarded(),
    syncConversation: (conversationId: string) => guarded(conversationId),
    isRunning: () => running,
    getState: () => state,
    cancel: () => {
      cancelled = true;
    },
  };
}
