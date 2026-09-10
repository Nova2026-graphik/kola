import { Stack, useRouter } from 'expo-router';
import { useCallback, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { OfflineBanner } from '../../../src/components/OfflineBanner';
import {
  clearPendingSelection,
  takePendingSelection,
} from '../../../src/features/groups/pendingSelection';
import { getRepositories } from '../../../src/repositories';

/**
 * Création d'un groupe, second temps : quoi (#37).
 *
 * Le nom est obligatoire, la photo facultative. La création n'attend PAS le
 * réseau : elle écrit en base, met en file, et ouvre le groupe. C'est ce qui
 * permet de créer une tontine dans un taxi sans couverture et d'y écrire tout
 * de suite (ADR-0002).
 */

const MAX_TITLE = 80;

export default function GroupDetailsScreen(): React.JSX.Element {
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const selected = useMemo(() => takePendingSelection(), []);

  const [title, setTitle] = useState('');
  const [isCreating, setIsCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const trimmed = title.trim();
  const canCreate = trimmed.length > 0 && trimmed.length <= MAX_TITLE && !isCreating;

  const create = useCallback(() => {
    if (!canCreate) {
      return;
    }
    setIsCreating(true);
    setError(null);

    void getRepositories()
      .conversations.createGroup({
        title: trimmed,
        memberIds: selected.map((person) => person.id),
      })
      .then((group) => {
        clearPendingSelection();
        // `replace` et non `push` : revenir en arrière depuis le groupe qu'on
        // vient de créer doit ramener à la liste, pas au formulaire.
        router.replace(`/conversation/${group.id}`);
      })
      .catch(() => {
        setIsCreating(false);
        setError('Le groupe n’a pas pu être créé. Vérifiez le nom et réessayez.');
      });
  }, [canCreate, router, selected, trimmed]);

  return (
    <KeyboardAvoidingView
      style={styles.container}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <Stack.Screen options={{ headerShown: false }} />
      <View style={{ paddingTop: insets.top }}>
        <OfflineBanner />

        <View style={styles.header}>
          <Pressable
            onPress={() => {
              router.back();
            }}
            hitSlop={12}
            accessibilityRole="button"
            accessibilityLabel="Revenir à la sélection"
          >
            <Text style={styles.back}>‹</Text>
          </Pressable>
          <Text style={styles.heading}>Nom du groupe</Text>
        </View>

        <TextInput
          style={styles.input}
          value={title}
          onChangeText={setTitle}
          placeholder="Tontine du quartier"
          placeholderTextColor="#8A8A8A"
          maxLength={MAX_TITLE}
          autoFocus
          accessibilityLabel="Nom du groupe"
        />

        <Text style={styles.hint}>
          {selected.length === 0
            ? 'Vous pourrez ajouter des membres ensuite.'
            : `${selected.length} membre${selected.length > 1 ? 's' : ''} : ${selected
                .map((person) => person.displayName ?? person.username)
                .join(', ')}`}
        </Text>

        {error === null ? null : <Text style={styles.error}>{error}</Text>}
      </View>

      <View style={[styles.footer, { paddingBottom: insets.bottom + 12 }]}>
        <Pressable
          style={[styles.create, !canCreate && styles.createOff]}
          onPress={create}
          disabled={!canCreate}
          accessibilityRole="button"
          accessibilityLabel="Créer le groupe"
          accessibilityState={{ disabled: !canCreate }}
        >
          {isCreating ? (
            <ActivityIndicator color="#FFFFFF" />
          ) : (
            <Text style={styles.createText}>Créer le groupe</Text>
          )}
        </Pressable>
      </View>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: { backgroundColor: '#FFFFFF', flex: 1, justifyContent: 'space-between' },
  header: { alignItems: 'center', flexDirection: 'row', gap: 12, padding: 16 },
  back: { color: '#1F1B16', fontSize: 30, lineHeight: 32 },
  heading: { color: '#1F1B16', fontSize: 20, fontWeight: '700' },
  input: {
    backgroundColor: '#F5F2EE',
    borderRadius: 12,
    color: '#1F1B16',
    fontSize: 18,
    marginHorizontal: 16,
    paddingHorizontal: 14,
    paddingVertical: 12,
  },
  hint: { color: '#6b6560', fontSize: 14, padding: 16 },
  error: { color: '#B3261E', fontSize: 14, paddingHorizontal: 16 },
  footer: { borderTopColor: '#EDE8E2', borderTopWidth: 1, padding: 16 },
  create: {
    alignItems: 'center',
    backgroundColor: '#1F1B16',
    borderRadius: 12,
    paddingVertical: 14,
  },
  createOff: { backgroundColor: '#C9C2BA' },
  createText: { color: '#FFFFFF', fontSize: 16, fontWeight: '600' },
});
