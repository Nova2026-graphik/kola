import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useState } from 'react';
import {
  Alert,
  FlatList,
  Pressable,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import type { MemberView } from '@kola/core';

import { OfflineBanner } from '../../../src/components/OfflineBanner';
import { useGroupInfo } from '../../../src/features/groups/useGroupInfo';
import { useCurrentUserId } from '../../../src/features/profiles/useProfiles';
import { useNow } from '../../../src/hooks/useNow';
import { getRepositories } from '../../../src/repositories';

/**
 * Informations d'un groupe (#38, #39, #42).
 *
 * Le tableau de bord du groupe : qui en fait partie, qui l'administre, comment
 * on le quitte, et comment on le fait taire.
 *
 * Tout se lit en local — l'écran s'ouvre hors ligne. Les actions écrivent en
 * local puis passent par la file : mettre un groupe en sourdine dans une zone
 * sans réseau doit fonctionner tout de suite, c'est précisément là qu'on en a
 * besoin.
 *
 * L'interface reflète les permissions pour ne pas proposer d'action vouée à
 * l'échec. Elle ne constitue jamais la sécurité : celle-ci est portée par RLS et
 * les triggers, et un appel direct à l'API s'y heurte de la même façon (#14).
 */

const ROW_HEIGHT = 64;
const MUTE_FOREVER = 8_640_000_000_000;

const ROLE_LABEL: Record<MemberView['role'], string> = {
  owner: 'Propriétaire',
  admin: 'Administrateur',
  member: '',
};

export default function GroupInfoScreen(): React.JSX.Element {
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id: string }>();
  const currentUserId = useCurrentUserId();
  const { conversation, members, allows } = useGroupInfo(id);

  const [title, setTitle] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const repositories = () => getRepositories().conversations;
  // Instant stable : `Date.now()` au rendu le rendrait impur, et l'échéance de
  // la sourdine changerait de valeur entre deux rendus du même instant.
  const now = useNow();
  const isMuted = (conversation?.mutedUntil ?? 0) > now;
  const isPinned = (conversation?.pinnedAt ?? null) !== null;

  const saveTitle = useCallback(() => {
    if (title === null || title.trim() === conversation?.title) {
      setTitle(null);
      return;
    }
    void repositories()
      .updateGroup(id, { title })
      .then(() => {
        setTitle(null);
        setError(null);
      })
      .catch((cause: unknown) => {
        setError(cause instanceof Error ? cause.message : 'Le nom n’a pas pu être changé.');
      });
  }, [conversation?.title, id, title]);

  const leave = useCallback(() => {
    Alert.alert('Quitter le groupe ?', 'Vous ne recevrez plus ses messages.', [
      { text: 'Annuler', style: 'cancel' },
      {
        text: 'Quitter',
        style: 'destructive',
        onPress: () => {
          void repositories()
            .leaveGroup(id)
            .then(() => {
              router.replace('/');
            })
            .catch((cause: unknown) => {
              setError(
                cause instanceof Error ? cause.message : 'Le départ n’a pas pu être enregistré.',
              );
            });
        },
      },
    ]);
  }, [id, router]);

  const actOnMember = useCallback(
    (member: MemberView) => {
      if (member.userId === currentUserId) {
        return;
      }
      const name = member.displayName ?? member.username ?? 'ce membre';
      const actions: { text: string; style?: 'destructive' | 'cancel'; onPress?: () => void }[] =
        [];

      if (allows('change_role')) {
        actions.push(
          member.role === 'admin'
            ? {
                text: 'Retirer les droits d’administrateur',
                onPress: () => {
                  void repositories().setMemberRole(id, member.userId, 'member');
                },
              }
            : {
                text: 'Nommer administrateur',
                onPress: () => {
                  void repositories().setMemberRole(id, member.userId, 'admin');
                },
              },
        );
      }

      if (allows('transfer_ownership') && member.role !== 'owner') {
        actions.push({
          text: 'Transférer la propriété',
          onPress: () => {
            Alert.alert(
              'Transférer la propriété ?',
              `${name} deviendra propriétaire du groupe. Vous serez administrateur.`,
              [
                { text: 'Annuler', style: 'cancel' },
                {
                  text: 'Transférer',
                  style: 'destructive',
                  onPress: () => {
                    void repositories().transferOwnership(id, member.userId);
                  },
                },
              ],
            );
          },
        });
      }

      // Le propriétaire n'est retirable par personne : un groupe ne se retrouve
      // jamais sans propriétaire (#39).
      if (allows('remove_member') && member.role !== 'owner') {
        actions.push({
          text: `Retirer ${name}`,
          style: 'destructive',
          onPress: () => {
            void repositories().removeMember(id, member.userId);
          },
        });
      }

      if (actions.length === 0) {
        return;
      }
      Alert.alert(name, undefined, [...actions, { text: 'Annuler', style: 'cancel' }]);
    },
    [allows, currentUserId, id],
  );

  const renderMember = useCallback(
    ({ item }: { item: MemberView }) => {
      const name = item.displayName ?? item.username ?? 'Sans nom';
      const label = ROLE_LABEL[item.role];
      return (
        <Pressable
          style={styles.row}
          onPress={() => {
            actOnMember(item);
          }}
          accessibilityRole="button"
          accessibilityLabel={label === '' ? name : `${name}, ${label}`}
        >
          <View style={styles.identity}>
            <Text style={styles.name} numberOfLines={1}>
              {name}
              {item.userId === currentUserId ? ' (vous)' : ''}
            </Text>
            {item.username === null ? null : (
              <Text style={styles.handle} numberOfLines={1}>
                @{item.username}
              </Text>
            )}
          </View>
          {label === '' ? null : <Text style={styles.role}>{label}</Text>}
        </Pressable>
      );
    },
    [actOnMember, currentUserId],
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
          accessibilityLabel="Revenir à la conversation"
        >
          <Text style={styles.back}>‹</Text>
        </Pressable>
        <Text style={styles.heading}>Informations</Text>
      </View>

      <FlatList
        data={members}
        keyExtractor={(item) => item.userId}
        renderItem={renderMember}
        getItemLayout={(_, index) => ({ length: ROW_HEIGHT, offset: ROW_HEIGHT * index, index })}
        keyboardShouldPersistTaps="handled"
        ListHeaderComponent={
          <View>
            {allows('edit_group') ? (
              <TextInput
                style={styles.titleInput}
                value={title ?? conversation?.title ?? ''}
                onChangeText={setTitle}
                onBlur={saveTitle}
                maxLength={80}
                accessibilityLabel="Nom du groupe"
              />
            ) : (
              <Text style={styles.title}>{conversation?.title ?? ''}</Text>
            )}

            {error === null ? null : <Text style={styles.error}>{error}</Text>}

            <View style={styles.setting}>
              <Text style={styles.settingLabel}>Sourdine</Text>
              <Switch
                value={isMuted}
                onValueChange={(next) => {
                  // La sourdine part sur le serveur : elle doit empêcher
                  // l'ENVOI de la notification, pas seulement son affichage
                  // (#58). Envoyer puis masquer coûterait des données pour rien.
                  void repositories().setPrefs(id, { mutedUntil: next ? MUTE_FOREVER : null });
                }}
                accessibilityLabel="Mettre le groupe en sourdine"
              />
            </View>

            <View style={styles.setting}>
              <Text style={styles.settingLabel}>Épinglé en tête de liste</Text>
              <Switch
                value={isPinned}
                onValueChange={(next) => {
                  void repositories().setPrefs(id, { pinnedAt: next ? now : null });
                }}
                accessibilityLabel="Épingler la conversation"
              />
            </View>

            {allows('set_restricted') ? (
              <View style={styles.setting}>
                <Text style={styles.settingLabel}>Seuls les administrateurs écrivent</Text>
                <Switch
                  value={conversation?.restricted ?? false}
                  onValueChange={(next) => {
                    void repositories().updateGroup(id, { restricted: next });
                  }}
                  accessibilityLabel="Restreindre l’écriture aux administrateurs"
                />
              </View>
            ) : null}

            <Text style={styles.sectionTitle}>
              {members.length} membre{members.length > 1 ? 's' : ''}
            </Text>
          </View>
        }
        ListFooterComponent={
          <View style={{ paddingBottom: insets.bottom + 24 }}>
            {allows('leave') ? (
              <Pressable
                style={styles.leave}
                onPress={leave}
                accessibilityRole="button"
                accessibilityLabel="Quitter le groupe"
              >
                <Text style={styles.leaveText}>Quitter le groupe</Text>
              </Pressable>
            ) : (
              // Le propriétaire n'a pas la permission de partir. Le dire est
              // plus utile qu'un bouton grisé sans explication (#39).
              <Text style={styles.notice}>
                Vous êtes propriétaire de ce groupe. Transférez la propriété à quelqu’un d’autre
                pour pouvoir le quitter.
              </Text>
            )}
          </View>
        }
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { backgroundColor: '#FFFFFF', flex: 1 },
  header: { alignItems: 'center', flexDirection: 'row', gap: 12, padding: 16 },
  back: { color: '#1F1B16', fontSize: 30, lineHeight: 32 },
  heading: { color: '#1F1B16', fontSize: 20, fontWeight: '700' },
  title: { color: '#1F1B16', fontSize: 22, fontWeight: '700', paddingHorizontal: 16 },
  titleInput: {
    backgroundColor: '#F5F2EE',
    borderRadius: 12,
    color: '#1F1B16',
    fontSize: 20,
    fontWeight: '700',
    marginHorizontal: 16,
    paddingHorizontal: 14,
    paddingVertical: 10,
  },
  error: { color: '#B3261E', fontSize: 14, paddingHorizontal: 16, paddingTop: 8 },
  setting: {
    alignItems: 'center',
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 12,
  },
  settingLabel: { color: '#1F1B16', flex: 1, fontSize: 16 },
  sectionTitle: {
    color: '#6b6560',
    fontSize: 13,
    fontWeight: '600',
    paddingHorizontal: 16,
    paddingTop: 16,
    textTransform: 'uppercase',
  },
  row: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 12,
    height: ROW_HEIGHT,
    paddingHorizontal: 16,
  },
  identity: { flex: 1 },
  name: { color: '#1F1B16', fontSize: 16 },
  handle: { color: '#6b6560', fontSize: 13 },
  role: { color: '#6b6560', fontSize: 13 },
  notice: { color: '#6b6560', fontSize: 14, padding: 16 },
  leave: { padding: 16 },
  leaveText: { color: '#B3261E', fontSize: 16, fontWeight: '600' },
});
