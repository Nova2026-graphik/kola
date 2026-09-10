import { useRouter } from 'expo-router';
import { useCallback, useState } from 'react';
import { FlatList, StyleSheet, Text, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { OfflineBanner } from '../../src/components/OfflineBanner';
import { ConversationListItem } from '../../src/features/conversations/ConversationListItem';
import type { ConversationRow } from '../../src/features/conversations/rows';
import { useConversations } from '../../src/features/conversations/useConversations';
import { useCurrentUserId, useProfiles } from '../../src/features/profiles/useProfiles';

/**
 * Liste des conversations — écran d'accueil (#29).
 *
 * Il s'ouvre au démarrage et doit s'afficher en moins de 500 ms, hors réseau
 * compris : il lit SQLite, jamais le réseau (ADR-0002, ADR-0006).
 */

/** Hauteur fixe d'une ligne : permet `getItemLayout`, donc un défilement sans calcul. */
const ROW_HEIGHT = 72;

export default function ConversationsScreen(): React.JSX.Element {
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const profiles = useProfiles();
  const currentUserId = useCurrentUserId();
  const [search, setSearch] = useState('');

  const { rows, isLoading, isEmpty } = useConversations({
    currentUserId: currentUserId ?? '',
    profiles,
    search,
  });

  const openConversation = useCallback(
    (id: string) => {
      router.push(`/conversation/${id}`);
    },
    [router],
  );

  const renderItem = useCallback(
    ({ item }: { item: ConversationRow }) => (
      <ConversationListItem row={item} onPress={openConversation} />
    ),
    [openConversation],
  );

  return (
    <View style={[styles.container, { paddingTop: insets.top }]}>
      <OfflineBanner />

      <View style={styles.header}>
        <Text style={styles.heading}>Kola</Text>
        <TextInput
          style={styles.search}
          value={search}
          onChangeText={setSearch}
          placeholder="Rechercher"
          placeholderTextColor="#8A8A8A"
          // La recherche est locale : rien n'est envoyé, rien n'est temporisé.
          autoCorrect={false}
          returnKeyType="search"
          accessibilityLabel="Rechercher une conversation"
        />
      </View>

      {isLoading ? (
        <SkeletonList />
      ) : (
        <FlatList
          data={rows}
          keyExtractor={keyOf}
          renderItem={renderItem}
          getItemLayout={itemLayout}
          // Réglages qui comptent sur un appareil à 2 Go : ne garder en mémoire
          // que ce qui est proche de l'écran.
          removeClippedSubviews
          initialNumToRender={12}
          maxToRenderPerBatch={8}
          windowSize={7}
          keyboardShouldPersistTaps="handled"
          ListEmptyComponent={<EmptyState hasSearch={search.trim() !== ''} isEmpty={isEmpty} />}
          contentContainerStyle={rows.length === 0 ? styles.emptyContainer : undefined}
        />
      )}
    </View>
  );
}

function keyOf(row: ConversationRow): string {
  return row.id;
}

function itemLayout(
  _data: ArrayLike<ConversationRow> | null | undefined,
  index: number,
): { length: number; offset: number; index: number } {
  return { length: ROW_HEIGHT, offset: ROW_HEIGHT * index, index };
}

/**
 * Squelettes plutôt qu'un indicateur tournant.
 *
 * Sur un appareil lent, un indicateur qui tourne donne l'impression que rien ne
 * se passe ; des formes à la bonne place montrent ce qui arrive.
 */
function SkeletonList(): React.JSX.Element {
  return (
    <View accessibilityLabel="Chargement des conversations">
      {Array.from({ length: 8 }, (_, index) => (
        <View key={index} style={styles.skeletonRow}>
          <View style={styles.skeletonAvatar} />
          <View style={styles.skeletonBody}>
            <View style={[styles.skeletonLine, styles.skeletonTitle]} />
            <View style={styles.skeletonLine} />
          </View>
        </View>
      ))}
    </View>
  );
}

function EmptyState({
  hasSearch,
  isEmpty,
}: {
  readonly hasSearch: boolean;
  readonly isEmpty: boolean;
}): React.JSX.Element | null {
  if (!isEmpty && !hasSearch) {
    return null;
  }

  return (
    <View style={styles.empty}>
      <Text style={styles.emptyTitle}>{hasSearch ? 'Aucun résultat' : 'Aucune conversation'}</Text>
      <Text style={styles.emptyText}>
        {hasSearch
          ? 'Essayez un autre nom.'
          : 'Vos conversations apparaîtront ici. Vous pouvez écrire même sans réseau : vos messages partiront à la reconnexion.'}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#FFFFFF',
  },
  header: {
    paddingHorizontal: 16,
    paddingBottom: 12,
    gap: 12,
  },
  heading: {
    fontSize: 28,
    fontWeight: '700',
    color: '#A8402C',
  },
  search: {
    height: 40,
    borderRadius: 20,
    paddingHorizontal: 16,
    backgroundColor: '#F2EFEC',
    color: '#1A1A1A',
    fontSize: 15,
  },
  emptyContainer: {
    flexGrow: 1,
  },
  empty: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 32,
    gap: 8,
  },
  emptyTitle: {
    fontSize: 17,
    fontWeight: '600',
    color: '#1A1A1A',
  },
  emptyText: {
    fontSize: 14,
    lineHeight: 20,
    textAlign: 'center',
    color: '#6A6A6A',
  },
  skeletonRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 10,
    height: ROW_HEIGHT,
    gap: 12,
  },
  skeletonAvatar: {
    width: 52,
    height: 52,
    borderRadius: 26,
    backgroundColor: '#EDE9E6',
  },
  skeletonBody: {
    flex: 1,
    gap: 8,
  },
  skeletonLine: {
    height: 10,
    borderRadius: 5,
    backgroundColor: '#EDE9E6',
  },
  skeletonTitle: {
    width: '45%',
  },
});
