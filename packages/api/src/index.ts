import type { ConversationType, MemberRole, SyncCursor } from '@kola/core';

/**
 * Contrat minimal d'un repository, posé ici pour figer la règle d'architecture :
 * l'interface lit SQLite, jamais le réseau. Les implémentations arrivent en #28.
 *
 * @see docs/adr/0002-architecture-local-first.md
 */
export interface Repository<T> {
  /** Lecture locale. Ne déclenche jamais de requête réseau. */
  readonly findLocal: (id: string) => Promise<T | null>;
}

/** Descripteur de conversation partagé par les repositories. */
export interface ConversationSummary {
  readonly id: string;
  readonly type: ConversationType;
  readonly role: MemberRole;
  readonly cursor: SyncCursor;
}
