import { memo } from 'react';
import { Image, Pressable, StyleSheet, Text, View } from 'react-native';

import type { SyncStatus } from '@kola/core';

import type { ConversationRow } from './rows';

/**
 * Une ligne de la liste des conversations.
 *
 * Mémoïsée : une liste de deux cents lignes qui se re-rendent toutes à chaque
 * message reçu saturerait un appareil à 2 Go. Toutes les props sont des valeurs
 * primitives ou des objets stables, pour que la comparaison superficielle
 * suffise.
 */

const MIN_TOUCH_TARGET = 44;

/** Icône d'état, pour le dernier message envoyé par soi. */
function statusGlyph(status: SyncStatus): string {
  switch (status) {
    case 'pending':
      // Distinct de « envoyé » à dessein : beaucoup d'applications confondent
      // les deux et laissent croire à un envoi réussi.
      return '🕐';
    case 'failed':
      return '⚠️';
    default:
      return '✓';
  }
}

function statusLabel(status: SyncStatus): string {
  switch (status) {
    case 'pending':
      return 'en attente d’envoi';
    case 'failed':
      return 'échec de l’envoi';
    default:
      return 'envoyé';
  }
}

interface Props {
  readonly row: ConversationRow;
  readonly onPress: (id: string) => void;
}

function ConversationListItemComponent({ row, onPress }: Props): React.JSX.Element {
  const hasUnread = row.unreadCount > 0;

  return (
    <Pressable
      style={styles.container}
      onPress={() => {
        onPress(row.id);
      }}
      accessibilityRole="button"
      // Un libellé composé : sans lui, le lecteur d'écran énumère des fragments
      // sans rapport les uns avec les autres (#64).
      accessibilityLabel={[
        row.title,
        row.preview,
        hasUnread ? `${String(row.unreadCount)} messages non lus` : null,
        row.isMuted ? 'en sourdine' : null,
      ]
        .filter(Boolean)
        .join(', ')}
    >
      {row.avatarUrl ? (
        <Image source={{ uri: row.avatarUrl }} style={styles.avatar} />
      ) : (
        <View style={[styles.avatar, styles.avatarFallback]}>
          <Text style={styles.initials}>{row.initials}</Text>
        </View>
      )}

      <View style={styles.body}>
        <View style={styles.topLine}>
          <Text style={styles.title} numberOfLines={1}>
            {row.isPinned ? '📌 ' : ''}
            {row.title}
          </Text>
          <Text style={styles.timestamp}>{row.timestamp}</Text>
        </View>

        <View style={styles.bottomLine}>
          {row.ownMessageStatus ? (
            <Text style={styles.status} accessibilityLabel={statusLabel(row.ownMessageStatus)}>
              {statusGlyph(row.ownMessageStatus)}{' '}
            </Text>
          ) : null}

          <Text style={[styles.preview, hasUnread && styles.previewUnread]} numberOfLines={1}>
            {row.preview}
          </Text>

          {row.isMuted ? <Text style={styles.muted}> 🔕</Text> : null}

          {hasUnread ? (
            <View style={[styles.badge, row.isMuted && styles.badgeMuted]}>
              <Text style={styles.badgeText}>{row.unreadCount > 99 ? '99+' : row.unreadCount}</Text>
            </View>
          ) : null}
        </View>
      </View>
    </Pressable>
  );
}

export const ConversationListItem = memo(ConversationListItemComponent);

const styles = StyleSheet.create({
  container: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 10,
    minHeight: 72,
    gap: 12,
  },
  avatar: {
    width: 52,
    height: 52,
    borderRadius: 26,
  },
  avatarFallback: {
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#A8402C',
  },
  initials: {
    color: '#F5EFE6',
    fontSize: 18,
    fontWeight: '600',
  },
  body: {
    flex: 1,
    gap: 4,
  },
  topLine: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  title: {
    flex: 1,
    fontSize: 16,
    fontWeight: '600',
    color: '#1A1A1A',
  },
  timestamp: {
    fontSize: 12,
    color: '#8A8A8A',
  },
  bottomLine: {
    flexDirection: 'row',
    alignItems: 'center',
    minHeight: 20,
  },
  status: {
    fontSize: 12,
  },
  preview: {
    flex: 1,
    fontSize: 14,
    color: '#6A6A6A',
  },
  previewUnread: {
    color: '#1A1A1A',
    fontWeight: '500',
  },
  muted: {
    fontSize: 12,
  },
  badge: {
    minWidth: 22,
    height: 22,
    borderRadius: 11,
    paddingHorizontal: 6,
    marginLeft: 8,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#A8402C',
  },
  badgeMuted: {
    // La sourdine ne masque pas le compte : elle en atténue seulement l'appel.
    backgroundColor: '#B0A9A4',
  },
  badgeText: {
    color: '#FFFFFF',
    fontSize: 12,
    fontWeight: '600',
  },
});

export { MIN_TOUCH_TARGET };
