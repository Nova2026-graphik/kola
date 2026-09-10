import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useEffect } from 'react';
import {
  FlatList,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { formatConversationTimestamp } from '@kola/core';

import { OfflineBanner } from '../../../src/components/OfflineBanner';
import { Composer } from '../../../src/features/messages/Composer';
import type { FeedItem } from '../../../src/features/messages/grouping';
import { MessageBubble } from '../../../src/features/messages/MessageBubble';
import { PendingBanner } from '../../../src/features/messages/PendingBanner';
import { SystemMessage } from '../../../src/features/messages/SystemMessage';
import { useMessageFeed } from '../../../src/features/messages/useMessageFeed';
import { useUnsentCounts } from '../../../src/features/messages/useUnsentCounts';
import { useCurrentUserId, useProfiles } from '../../../src/features/profiles/useProfiles';
import { useNow } from '../../../src/hooks/useNow';
import { getRepositories } from '../../../src/repositories';
import { openConversation } from '../../../src/sync/bootstrap';

/**
 * Écran de conversation (#30).
 *
 * La liste est **inversée** : c'est la seule façon d'obtenir un ancrage correct
 * en bas sans calculs de position fragiles. Conséquence, l'élément d'indice 0
 * est le message le plus récent, et les séparateurs de date s'insèrent après
 * les messages du jour qu'ils annoncent — toute cette logique est dans
 * `grouping.ts`, où elle est testée.
 */

export default function ConversationScreen(): React.JSX.Element {
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id: string }>();
  const profiles = useProfiles();
  const currentUserId = useCurrentUserId();
  // Instant stable : `Date.now()` au rendu le rendrait impur et casserait la
  // mémoïsation des bulles.
  const now = useNow();
  const unsent = useUnsentCounts(id);

  const { items, isLoading, hasMore, initialIndex, loadMore } = useMessageFeed({
    conversationId: id,
    currentUserId,
  });

  // Ouvrir un fil le fait passer en tête de la file de synchronisation (#53) :
  // sur un réseau lent, la première page rattrapée doit être celle que
  // l'utilisateur regarde, pas celle d'un tri arbitraire. L'appel ne bloque
  // rien — l'écran s'affiche sur la base locale.
  useEffect(() => {
    openConversation(id);
  }, [id]);

  const retry = useCallback((clientId: string) => {
    void getRepositories().messages.retryMessage(clientId);
  }, []);

  const renderItem = useCallback(
    ({ item }: { item: FeedItem }) => {
      if (item.type === 'date') {
        return (
          <View style={styles.separator}>
            <Text style={styles.separatorText}>{item.label}</Text>
          </View>
        );
      }

      if (item.type === 'unread') {
        return (
          <View style={styles.unread}>
            <Text style={styles.unreadText}>
              {item.count} nouveau{item.count > 1 ? 'x' : ''} message
              {item.count > 1 ? 's' : ''}
            </Text>
          </View>
        );
      }

      // Un message système n'est la parole de personne : il ne prend ni bulle
      // ni avatar, et sa phrase est construite à l'affichage (#41).
      if (item.message.kind === 'system') {
        return <SystemMessage message={item.message} resolveName={resolveName} />;
      }

      const sender = item.message.senderId === null ? null : profiles.get(item.message.senderId);

      return (
        <MessageBubble
          message={item.message}
          isOwn={item.message.senderId === currentUserId}
          groupedWithPrevious={item.groupedWithPrevious}
          isLastOfGroup={item.isLastOfGroup}
          senderName={sender?.displayName ?? sender?.username ?? null}
          time={formatConversationTimestamp(item.message.createdAt, now)}
          onRetry={retry}
        />
      );
    },
    [currentUserId, now, profiles, resolveName, retry],
  );

  return (
    <View style={[styles.container, { paddingTop: insets.top }]}>
      <Stack.Screen options={{ headerShown: false }} />

      <View style={styles.header}>
        <Pressable
          onPress={() => {
            router.back();
          }}
          style={styles.back}
          accessibilityRole="button"
          accessibilityLabel="Retour aux conversations"
        >
          <Text style={styles.backText}>‹</Text>
        </Pressable>
        <Pressable
          style={styles.titleZone}
          onPress={() => {
            router.push(`/conversation/${id}-infos`);
          }}
          accessibilityRole="button"
          accessibilityLabel="Informations du groupe"
        >
          <Text style={styles.title} numberOfLines={1}>
            Conversation
          </Text>
        </Pressable>
      </View>

      <OfflineBanner />
      <PendingBanner pendingCount={unsent.pending} failedCount={unsent.failed} />

      <KeyboardAvoidingView
        style={styles.flex}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        keyboardVerticalOffset={insets.top}
      >
        <FlatList
          data={items}
          keyExtractor={keyOf}
          renderItem={renderItem}
          // L'ancrage en bas sans calcul de position.
          inverted
          initialScrollIndex={initialIndex > 0 ? initialIndex : undefined}
          // « onEndReached » sur une liste inversée signifie « on remonte vers le
          // passé » : c'est là que se charge la page suivante.
          onEndReached={hasMore ? loadMore : undefined}
          onEndReachedThreshold={0.4}
          removeClippedSubviews
          initialNumToRender={20}
          maxToRenderPerBatch={12}
          windowSize={9}
          keyboardShouldPersistTaps="handled"
          ListEmptyComponent={isLoading ? null : <EmptyConversation />}
          contentContainerStyle={items.length === 0 ? styles.emptyContainer : styles.content}
        />

        {/* Le composeur ne se désactive jamais, pas même hors ligne. */}
        <Composer conversationId={id} senderId={currentUserId} />
      </KeyboardAvoidingView>
    </View>
  );
}

function keyOf(item: FeedItem): string {
  return item.key;
}

function EmptyConversation(): React.JSX.Element {
  return (
    <View style={styles.empty}>
      <Text style={styles.emptyText}>
        Aucun message pour l’instant. Écrivez le premier — même hors ligne, il partira au retour du
        réseau.
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  titleZone: { flex: 1 },
  flex: {
    flex: 1,
  },
  container: {
    flex: 1,
    backgroundColor: '#FFFFFF',
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 8,
    paddingBottom: 8,
    gap: 4,
  },
  back: {
    width: 44,
    height: 44,
    alignItems: 'center',
    justifyContent: 'center',
  },
  backText: {
    fontSize: 30,
    lineHeight: 34,
    color: '#A8402C',
  },
  title: {
    flex: 1,
    fontSize: 17,
    fontWeight: '600',
    color: '#1A1A1A',
  },
  content: {
    paddingVertical: 12,
  },
  separator: {
    alignItems: 'center',
    marginVertical: 12,
  },
  separatorText: {
    fontSize: 12,
    color: '#8A8A8A',
    backgroundColor: '#F2EFEC',
    paddingHorizontal: 12,
    paddingVertical: 4,
    borderRadius: 10,
    overflow: 'hidden',
  },
  unread: {
    alignItems: 'center',
    marginVertical: 8,
  },
  unreadText: {
    fontSize: 12,
    fontWeight: '600',
    color: '#A8402C',
  },
  emptyContainer: {
    flexGrow: 1,
    justifyContent: 'center',
  },
  empty: {
    paddingHorizontal: 32,
    // La liste est inversée : sans ce retournement, le texte s'afficherait à
    // l'envers.
    transform: [{ scaleY: -1 }],
  },
  emptyText: {
    fontSize: 14,
    lineHeight: 20,
    textAlign: 'center',
    color: '#6A6A6A',
  },
});
