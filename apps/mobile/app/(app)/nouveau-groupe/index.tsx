import { Stack, useRouter } from 'expo-router';
import { useCallback } from 'react';
import { FlatList, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { OfflineBanner } from '../../../src/components/OfflineBanner';
import { setPendingSelection } from '../../../src/features/groups/pendingSelection';
import { usePeoplePicker, type Person } from '../../../src/features/groups/usePeoplePicker';
import { useCurrentUserId } from '../../../src/features/profiles/useProfiles';

/**
 * Création d'un groupe, premier temps : qui (#37).
 *
 * Le parcours est en deux écrans plutôt qu'en un seul formulaire. La raison
 * n'est pas esthétique : sur un écran de téléphone d'entrée de gamme, une liste
 * de personnes et un formulaire ne tiennent pas ensemble sans que le clavier
 * recouvre l'un ou l'autre.
 */

const ROW_HEIGHT = 64;

export default function GroupMembersScreen(): React.JSX.Element {
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const currentUserId = useCurrentUserId();
  const picker = usePeoplePicker(currentUserId);

  const goToDetails = useCallback(() => {
    setPendingSelection(picker.selected);
    router.push('/nouveau-groupe/details');
  }, [picker.selected, router]);

  const renderItem = useCallback(
    ({ item }: { item: Person }) => {
      const checked = picker.isSelected(item.id);
      const name = item.displayName ?? item.username ?? 'Sans nom';
      return (
        <Pressable
          style={styles.row}
          onPress={() => {
            picker.toggle(item);
          }}
          accessibilityRole="checkbox"
          accessibilityState={{ checked }}
          accessibilityLabel={name}
        >
          <View style={[styles.check, checked && styles.checkOn]}>
            {checked ? <Text style={styles.checkMark}>✓</Text> : null}
          </View>
          <View style={styles.identity}>
            <Text style={styles.name} numberOfLines={1}>
              {name}
            </Text>
            {item.username === null ? null : (
              <Text style={styles.handle} numberOfLines={1}>
                @{item.username}
              </Text>
            )}
          </View>
        </Pressable>
      );
    },
    [picker],
  );

  return (
    <View style={[styles.container, { paddingTop: insets.top }]}>
      <Stack.Screen options={{ headerShown: false }} />
      <OfflineBanner />

      <View style={styles.header}>
        <Pressable
          onPress={() => {
            router.back();
          }}
          hitSlop={12}
          accessibilityRole="button"
          accessibilityLabel="Revenir"
        >
          <Text style={styles.back}>‹</Text>
        </Pressable>
        <Text style={styles.heading}>Nouveau groupe</Text>
      </View>

      {picker.selected.length === 0 ? null : (
        <View style={styles.tokens}>
          {picker.selected.map((person) => (
            <Pressable
              key={person.id}
              style={styles.token}
              onPress={() => {
                picker.toggle(person);
              }}
              accessibilityRole="button"
              accessibilityLabel={`Retirer ${person.displayName ?? person.username ?? ''}`}
            >
              <Text style={styles.tokenText} numberOfLines={1}>
                {person.displayName ?? person.username} ✕
              </Text>
            </Pressable>
          ))}
        </View>
      )}

      <TextInput
        style={styles.search}
        value={picker.query}
        onChangeText={picker.setQuery}
        placeholder="Chercher un pseudo"
        placeholderTextColor="#8A8A8A"
        autoCapitalize="none"
        autoCorrect={false}
        accessibilityLabel="Chercher une personne par son pseudo"
      />

      {picker.isOffline ? (
        <Text style={styles.notice}>
          Recherche indisponible hors ligne. Les personnes déjà connues restent proposées.
        </Text>
      ) : null}

      <FlatList
        data={picker.results}
        keyExtractor={(item) => item.id}
        renderItem={renderItem}
        getItemLayout={(_, index) => ({
          length: ROW_HEIGHT,
          offset: ROW_HEIGHT * index,
          index,
        })}
        keyboardShouldPersistTaps="handled"
        ListEmptyComponent={
          picker.isSearching ? null : (
            <Text style={styles.notice}>
              {picker.query.trim().length < 2
                ? 'Tapez au moins deux lettres pour chercher.'
                : 'Personne trouvée.'}
            </Text>
          )
        }
      />

      <View style={[styles.footer, { paddingBottom: insets.bottom + 12 }]}>
        <Pressable
          style={styles.next}
          onPress={goToDetails}
          accessibilityRole="button"
          accessibilityLabel="Continuer"
        >
          <Text style={styles.nextText}>
            Continuer{picker.selected.length > 0 ? ` (${picker.selected.length})` : ''}
          </Text>
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { backgroundColor: '#FFFFFF', flex: 1 },
  header: { alignItems: 'center', flexDirection: 'row', gap: 12, padding: 16 },
  back: { color: '#1F1B16', fontSize: 30, lineHeight: 32 },
  heading: { color: '#1F1B16', fontSize: 20, fontWeight: '700' },
  tokens: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, paddingHorizontal: 16 },
  token: {
    backgroundColor: '#F2E9DE',
    borderRadius: 16,
    paddingHorizontal: 12,
    paddingVertical: 6,
  },
  tokenText: { color: '#1F1B16', fontSize: 14, maxWidth: 160 },
  search: {
    backgroundColor: '#F5F2EE',
    borderRadius: 12,
    color: '#1F1B16',
    fontSize: 16,
    margin: 16,
    paddingHorizontal: 14,
    paddingVertical: 10,
  },
  row: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 12,
    height: ROW_HEIGHT,
    paddingHorizontal: 16,
  },
  check: {
    alignItems: 'center',
    borderColor: '#C9C2BA',
    borderRadius: 12,
    borderWidth: 2,
    height: 24,
    justifyContent: 'center',
    width: 24,
  },
  checkOn: { backgroundColor: '#1F1B16', borderColor: '#1F1B16' },
  checkMark: { color: '#FFFFFF', fontSize: 14, fontWeight: '700' },
  identity: { flex: 1 },
  name: { color: '#1F1B16', fontSize: 16 },
  handle: { color: '#6b6560', fontSize: 13 },
  notice: { color: '#6b6560', fontSize: 14, paddingHorizontal: 16, paddingVertical: 12 },
  footer: { borderTopColor: '#EDE8E2', borderTopWidth: 1, padding: 16 },
  next: { alignItems: 'center', backgroundColor: '#1F1B16', borderRadius: 12, paddingVertical: 14 },
  nextText: { color: '#FFFFFF', fontSize: 16, fontWeight: '600' },
});
