import { eq } from 'drizzle-orm';

import { drafts } from '../db/schema';

import type { LocalDatabase, RepositoryOptions, Transaction } from './database';

/**
 * Brouillons, un par conversation (#31).
 *
 * Un brouillon perdu parce que l'application a été fermée est une frustration
 * majeure — particulièrement ici, où l'on rédige souvent hors ligne pour
 * envoyer plus tard. Il vit donc en base, pas en mémoire, et survit à la
 * fermeture complète de l'application.
 */

export interface Draft {
  readonly conversationId: string;
  readonly body: string;
  readonly replyToId: string | null;
  readonly updatedAt: number;
}

export interface DraftRepository {
  readonly get: (conversationId: string) => Draft | null;
  /** Enregistre ou remplace. Un corps vide efface le brouillon. */
  readonly save: (conversationId: string, body: string, replyToId?: string | null) => void;
  readonly clear: (conversationId: string) => void;
  readonly list: () => readonly Draft[];
}

/**
 * Efface un brouillon **dans une transaction en cours**.
 *
 * Sert à ce que l'envoi et l'effacement soient atomiques : sinon un plantage
 * entre les deux laisserait le brouillon en place, et l'utilisateur
 * réenverrait un message déjà parti.
 */
export function clearDraftIn(tx: Transaction | LocalDatabase, conversationId: string): void {
  tx.delete(drafts).where(eq(drafts.conversationId, conversationId)).run();
}

export function createDraftRepository(options: RepositoryOptions): DraftRepository {
  const { db } = options;
  const now = options.now ?? (() => Date.now());

  return {
    get: (conversationId: string) => {
      const row = db.select().from(drafts).where(eq(drafts.conversationId, conversationId)).get();
      return row ?? null;
    },

    save: (conversationId: string, body: string, replyToId: string | null = null) => {
      // Un brouillon vide n'en est pas un : le conserver ferait réapparaître un
      // champ vide comme s'il contenait quelque chose.
      if (body.trim() === '') {
        clearDraftIn(db, conversationId);
        return;
      }

      db.insert(drafts)
        .values({ conversationId, body, replyToId, updatedAt: now() })
        .onConflictDoUpdate({
          target: drafts.conversationId,
          set: { body, replyToId, updatedAt: now() },
        })
        .run();
    },

    clear: (conversationId: string) => {
      clearDraftIn(db, conversationId);
    },

    list: () => db.select().from(drafts).all(),
  };
}
