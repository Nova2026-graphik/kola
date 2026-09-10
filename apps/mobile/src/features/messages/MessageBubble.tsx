import { memo } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import type { MessageView, SyncStatus } from '@kola/core';

/**
 * Bulle de message.
 *
 * Mémoïsée, et c'est essentiel : sans cela, chaque message reçu re-rendrait
 * toute la fenêtre visible. C'est le composant sur le chemin critique de
 * performance de l'application (ADR-0006).
 */

interface Props {
  readonly message: MessageView;
  readonly isOwn: boolean;
  readonly groupedWithPrevious: boolean;
  readonly isLastOfGroup: boolean;
  readonly senderName: string | null;
  readonly time: string;
  readonly onRetry?: (clientId: string) => void;
}

/**
 * État d'envoi, en toutes lettres pour le lecteur d'écran.
 *
 * « En attente » et « envoyé » doivent rester distincts : beaucoup
 * d'applications les confondent et laissent croire à un envoi réussi (#32).
 */
function statusFor(status: SyncStatus): { glyph: string; label: string } {
  switch (status) {
    case 'pending':
      return { glyph: '🕐', label: 'en attente d’envoi' };
    case 'failed':
      return { glyph: '⚠️', label: 'échec de l’envoi, toucher pour réessayer' };
    default:
      return { glyph: '✓', label: 'envoyé' };
  }
}

function MessageBubbleComponent(props: Props): React.JSX.Element {
  const { message, isOwn } = props;

  // Un message système s'affiche centré, hors du flux des bulles. Son contenu
  // est une charge structurée, traduite à l'affichage (#41, #63).
  if (message.kind === 'system') {
    return (
      <View style={styles.systemRow}>
        <Text style={styles.systemText}>{message.body}</Text>
      </View>
    );
  }

  if (message.deletedAt !== null) {
    return (
      <View style={[styles.row, isOwn ? styles.rowOwn : styles.rowOther]}>
        <View style={[styles.bubble, styles.bubbleDeleted]}>
          <Text style={styles.deletedText}>Message supprimé</Text>
        </View>
      </View>
    );
  }

  const status = isOwn ? statusFor(message.syncStatus) : null;
  const canRetry = isOwn && message.syncStatus === 'failed';

  return (
    <View
      style={[
        styles.row,
        isOwn ? styles.rowOwn : styles.rowOther,
        props.groupedWithPrevious && styles.rowGrouped,
      ]}
    >
      <Pressable
        style={[styles.bubble, isOwn ? styles.bubbleOwn : styles.bubbleOther]}
        onPress={canRetry ? () => props.onRetry?.(message.clientId) : undefined}
        accessibilityRole={canRetry ? 'button' : 'text'}
        accessibilityLabel={[
          props.senderName,
          message.body,
          message.editedAt !== null ? 'modifié' : null,
          status?.label,
        ]
          .filter(Boolean)
          .join(', ')}
      >
        {/* Le nom n'apparaît qu'en tête de salve, et jamais pour soi-même. */}
        {!isOwn && !props.groupedWithPrevious && props.senderName ? (
          <Text style={styles.sender}>{props.senderName}</Text>
        ) : null}

        <Text style={[styles.body, isOwn && styles.bodyOwn]}>{message.body}</Text>

        {/* L'horodatage ne s'affiche qu'en fin de salve : le répéter sur chaque
            bulle d'une rafale de cinq messages n'apprend rien. */}
        {props.isLastOfGroup ? (
          <View style={styles.meta}>
            {message.editedAt !== null ? (
              <Text style={[styles.metaText, isOwn && styles.metaTextOwn]}>modifié · </Text>
            ) : null}
            <Text style={[styles.metaText, isOwn && styles.metaTextOwn]}>{props.time}</Text>
            {status ? (
              <Text style={[styles.metaText, isOwn && styles.metaTextOwn]}> {status.glyph}</Text>
            ) : null}
          </View>
        ) : null}
      </Pressable>
    </View>
  );
}

export const MessageBubble = memo(MessageBubbleComponent);

const styles = StyleSheet.create({
  row: {
    paddingHorizontal: 12,
    marginTop: 8,
  },
  rowGrouped: {
    // Les bulles d'une même salve se touchent presque : c'est ce qui fait lire
    // la rafale comme un seul propos.
    marginTop: 2,
  },
  rowOwn: {
    alignItems: 'flex-end',
  },
  rowOther: {
    alignItems: 'flex-start',
  },
  bubble: {
    maxWidth: '80%',
    borderRadius: 16,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  bubbleOwn: {
    backgroundColor: '#A8402C',
  },
  bubbleOther: {
    backgroundColor: '#F2EFEC',
  },
  bubbleDeleted: {
    backgroundColor: 'transparent',
    borderWidth: 1,
    borderColor: '#DDD6D1',
  },
  sender: {
    fontSize: 12,
    fontWeight: '600',
    color: '#A8402C',
    marginBottom: 2,
  },
  body: {
    fontSize: 15,
    lineHeight: 21,
    color: '#1A1A1A',
  },
  bodyOwn: {
    color: '#F5EFE6',
  },
  deletedText: {
    fontSize: 14,
    fontStyle: 'italic',
    color: '#8A8A8A',
  },
  meta: {
    flexDirection: 'row',
    alignSelf: 'flex-end',
    marginTop: 2,
  },
  metaText: {
    fontSize: 11,
    color: '#8A8A8A',
  },
  metaTextOwn: {
    color: '#E8D5CF',
  },
  systemRow: {
    alignItems: 'center',
    paddingHorizontal: 24,
    marginVertical: 8,
  },
  systemText: {
    fontSize: 12,
    textAlign: 'center',
    color: '#8A8A8A',
  },
});
