import { useRouter } from 'expo-router';
import { useCallback, useMemo, useState } from 'react';
import {
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import {
  initialsOf,
  usernameErrorMessage,
  validateDisplayName,
  validateUsername,
  type UsernameError,
} from '@kola/core';

import { useCurrentUserId } from '../../src/features/auth/session';
import { useUsernameAvailability } from '../../src/features/auth/useUsernameAvailability';

/**
 * Création du profil (#22).
 *
 * Juste après la vérification du code, l'utilisateur n'a qu'un numéro. Il lui
 * faut une identité affichable pour que les autres le reconnaissent.
 *
 * Le pseudo sert aussi à se faire trouver sans partager son numéro — une
 * alternative importante à la découverte par carnet d'adresses.
 */
export default function ProfilScreen(): React.JSX.Element {
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const userId = useCurrentUserId();

  const [username, setUsername] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [bio, setBio] = useState('');
  const [saving, setSaving] = useState(false);

  const validation = useMemo(
    () => (username.trim() === '' ? null : validateUsername(username)),
    [username],
  );

  const availability = useUsernameAvailability(validation?.ok === true ? validation.value : null);

  const nameOk = validateDisplayName(displayName);
  const canSubmit =
    validation?.ok === true && availability.state === 'available' && nameOk && !saving;

  const submit = useCallback(() => {
    if (validation?.ok !== true || !nameOk || userId === null) {
      return;
    }
    setSaving(true);

    // L'écriture passe par un repository, jamais par le client réseau
    // directement (ADR-0002). Elle est mise en file si l'on est hors ligne.
    void import('../../src/features/auth/profile')
      .then(({ saveProfile }) =>
        saveProfile({
          userId,
          username: validation.value,
          displayName: displayName.trim(),
          bio: bio.trim() === '' ? null : bio.trim(),
        }),
      )
      .then(() => {
        router.replace('/');
      })
      .finally(() => {
        setSaving(false);
      });
  }, [bio, displayName, nameOk, router, userId, validation]);

  const usernameMessage = usernameFeedback(validation, availability.state);

  return (
    <KeyboardAvoidingView
      style={styles.container}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <ScrollView
        contentContainerStyle={[styles.content, { paddingTop: insets.top + 24 }]}
        keyboardShouldPersistTaps="handled"
      >
        <Text style={styles.title}>Votre profil</Text>
        <Text style={styles.subtitle}>
          C’est ce que verront les personnes avec qui vous discutez.
        </Text>

        {/* Avatar généré à partir des initiales : le profil doit être
            utilisable sans photo, notamment quand les données sont comptées. */}
        <View style={styles.avatarRow}>
          <View style={styles.avatar}>
            <Text style={styles.avatarInitials}>{initialsOf(displayName)}</Text>
          </View>
          <Text style={styles.avatarHint}>
            Vous pourrez ajouter une photo plus tard, depuis les réglages.
          </Text>
        </View>

        <View style={styles.field}>
          <Text style={styles.label}>Nom affiché</Text>
          <TextInput
            style={styles.input}
            value={displayName}
            onChangeText={setDisplayName}
            placeholder="Kofi Mensah"
            placeholderTextColor="#8A8A8A"
            maxLength={64}
            accessibilityLabel="Nom affiché"
          />
        </View>

        <View style={styles.field}>
          <Text style={styles.label}>Pseudo</Text>
          <TextInput
            style={styles.input}
            value={username}
            onChangeText={setUsername}
            placeholder="kofi"
            placeholderTextColor="#8A8A8A"
            autoCapitalize="none"
            autoCorrect={false}
            maxLength={24}
            accessibilityLabel="Pseudo, unique"
            accessibilityHint="Il permet aux autres de vous trouver sans connaître votre numéro"
          />
          {usernameMessage !== null ? (
            <Text
              style={[styles.hint, usernameMessage.tone === 'error' && styles.error]}
              accessibilityLiveRegion="polite"
            >
              {usernameMessage.text}
            </Text>
          ) : null}
        </View>

        <View style={styles.field}>
          <Text style={styles.label}>Bio (facultatif)</Text>
          <TextInput
            style={[styles.input, styles.bio]}
            value={bio}
            onChangeText={setBio}
            placeholder="Quelques mots sur vous"
            placeholderTextColor="#8A8A8A"
            multiline
            maxLength={280}
            accessibilityLabel="Bio, facultative"
          />
        </View>

        <Pressable
          style={[styles.submit, !canSubmit && styles.submitDisabled]}
          onPress={submit}
          disabled={!canSubmit}
          accessibilityRole="button"
          accessibilityLabel="Terminer"
          accessibilityState={{ disabled: !canSubmit }}
        >
          <Text style={styles.submitText}>{saving ? 'Enregistrement…' : 'Terminer'}</Text>
        </Pressable>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

type Feedback = { readonly text: string; readonly tone: 'error' | 'info' };

function usernameFeedback(
  validation: ReturnType<typeof validateUsername> | null,
  availability: 'idle' | 'checking' | 'available' | 'taken' | 'unknown',
): Feedback | null {
  if (validation === null) {
    return null;
  }
  if (!validation.ok) {
    return { text: usernameErrorMessage(validation.error as UsernameError), tone: 'error' };
  }

  switch (availability) {
    case 'checking':
      return { text: 'Vérification…', tone: 'info' };
    case 'available':
      return { text: 'Ce pseudo est disponible.', tone: 'info' };
    case 'taken':
      return { text: 'Ce pseudo est déjà pris.', tone: 'error' };
    case 'unknown':
      // Hors ligne : on ne peut pas vérifier. L'unicité réelle est de toute
      // façon garantie par la base (#8), la course sera tranchée à
      // l'enregistrement.
      return { text: 'Impossible de vérifier hors ligne.', tone: 'info' };
    default:
      return null;
  }
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#FFFFFF' },
  content: { paddingHorizontal: 24, paddingBottom: 32, gap: 16 },
  title: { fontSize: 26, fontWeight: '700', color: '#1A1A1A' },
  subtitle: { fontSize: 15, lineHeight: 21, color: '#6A6A6A' },
  avatarRow: { flexDirection: 'row', alignItems: 'center', gap: 16, marginVertical: 8 },
  avatar: {
    width: 72,
    height: 72,
    borderRadius: 36,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#A8402C',
  },
  avatarInitials: { fontSize: 26, fontWeight: '600', color: '#F5EFE6' },
  avatarHint: { flex: 1, fontSize: 13, lineHeight: 18, color: '#6A6A6A' },
  field: { gap: 6 },
  label: { fontSize: 13, fontWeight: '600', color: '#4A4A4A' },
  input: {
    height: 52,
    borderRadius: 12,
    paddingHorizontal: 14,
    backgroundColor: '#F2EFEC',
    color: '#1A1A1A',
    fontSize: 16,
  },
  bio: { height: 88, paddingTop: 14, textAlignVertical: 'top' },
  hint: { fontSize: 13, color: '#6A6A6A' },
  error: { color: '#A8402C' },
  submit: {
    height: 52,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#A8402C',
    marginTop: 8,
  },
  submitDisabled: { backgroundColor: '#D9CFC9' },
  submitText: { fontSize: 16, fontWeight: '600', color: '#FFFFFF' },
});
