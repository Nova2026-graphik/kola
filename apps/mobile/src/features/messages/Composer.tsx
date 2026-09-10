import { useCallback, useState } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

import { getRepositories } from '../../repositories';

import { useDraft } from './useDraft';

/**
 * Composeur de message (#31).
 *
 * C'est l'endroit où l'utilisateur produit de la valeur, et il ne se désactive
 * **jamais** — pas même hors ligne. Un message rédigé sans réseau est inséré
 * localement et mis en file ; il partira à la reconnexion (ADR-0002).
 * Désactiver la saisie reviendrait à renier la promesse centrale du produit.
 */

/** Au-delà, le champ cesse de grandir et défile. */
const MAX_INPUT_HEIGHT = 120;
const MIN_INPUT_HEIGHT = 40;

/** Émoji les plus courants, sans jeu d'images embarqué. */
const QUICK_EMOJI = ['😀', '😂', '❤️', '👍', '🙏', '😢', '🔥', '🎉'] as const;

interface Props {
  readonly conversationId: string;
  readonly senderId: string | null;
  readonly replyToId?: string | null;
  readonly onSent?: () => void;
}

export function Composer(props: Props): React.JSX.Element {
  const draft = useDraft(props.conversationId);
  const [height, setHeight] = useState(MIN_INPUT_HEIGHT);
  const [showEmoji, setShowEmoji] = useState(false);

  const canSend = draft.value.trim() !== '' && props.senderId !== null;

  const send = useCallback(() => {
    const body = draft.value.trim();
    if (body === '' || props.senderId === null) {
      return;
    }

    // `clearDraft` fait l'effacement dans la MÊME transaction que l'insertion :
    // le champ et le brouillon se vident ensemble, ou pas du tout.
    void getRepositories()
      .messages.sendMessage({
        conversationId: props.conversationId,
        senderId: props.senderId,
        body,
        replyToId: props.replyToId ?? null,
        clearDraft: true,
      })
      .then(() => {
        draft.reset();
        setHeight(MIN_INPUT_HEIGHT);
        props.onSent?.();
      });
  }, [draft, props]);

  const appendEmoji = useCallback(
    (emoji: string) => {
      draft.setValue(draft.value + emoji);
    },
    [draft],
  );

  return (
    <View style={styles.container}>
      {showEmoji ? (
        <View style={styles.emojiRow}>
          {QUICK_EMOJI.map((emoji) => (
            <Pressable
              key={emoji}
              style={styles.emojiButton}
              onPress={() => {
                appendEmoji(emoji);
              }}
              accessibilityRole="button"
              accessibilityLabel={`Insérer ${emoji}`}
            >
              <Text style={styles.emoji}>{emoji}</Text>
            </Pressable>
          ))}
        </View>
      ) : null}

      <View style={styles.row}>
        <Pressable
          style={styles.iconButton}
          onPress={() => {
            setShowEmoji((current) => !current);
          }}
          accessibilityRole="button"
          accessibilityLabel={showEmoji ? 'Masquer les émoji' : 'Afficher les émoji'}
        >
          <Text style={styles.icon}>🙂</Text>
        </Pressable>

        <TextInput
          style={[
            styles.input,
            { height: Math.max(MIN_INPUT_HEIGHT, Math.min(height, MAX_INPUT_HEIGHT)) },
          ]}
          value={draft.value}
          onChangeText={draft.setValue}
          onContentSizeChange={(event) => {
            setHeight(event.nativeEvent.contentSize.height + 16);
          }}
          onBlur={draft.flush}
          placeholder="Message"
          placeholderTextColor="#8A8A8A"
          multiline
          // Jamais désactivé, même sans réseau.
          editable
          accessibilityLabel="Rédiger un message"
          accessibilityHint="Votre message partira au retour du réseau si vous êtes hors ligne"
        />

        <Pressable
          style={[styles.sendButton, !canSend && styles.sendButtonDisabled]}
          onPress={send}
          disabled={!canSend}
          accessibilityRole="button"
          accessibilityLabel="Envoyer"
          accessibilityState={{ disabled: !canSend }}
        >
          <Text style={styles.sendIcon}>➤</Text>
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: '#E5E0DC',
    backgroundColor: '#FFFFFF',
  },
  emojiRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    paddingHorizontal: 8,
    paddingTop: 8,
  },
  emojiButton: {
    width: 44,
    height: 44,
    alignItems: 'center',
    justifyContent: 'center',
  },
  emoji: {
    fontSize: 24,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    paddingHorizontal: 8,
    paddingVertical: 8,
    gap: 6,
  },
  iconButton: {
    width: 44,
    height: 44,
    alignItems: 'center',
    justifyContent: 'center',
  },
  icon: {
    fontSize: 22,
  },
  input: {
    flex: 1,
    borderRadius: 20,
    paddingHorizontal: 14,
    paddingTop: 10,
    paddingBottom: 10,
    backgroundColor: '#F2EFEC',
    color: '#1A1A1A',
    fontSize: 15,
    lineHeight: 20,
  },
  sendButton: {
    width: 44,
    height: 44,
    borderRadius: 22,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#A8402C',
  },
  sendButtonDisabled: {
    backgroundColor: '#D9CFC9',
  },
  sendIcon: {
    fontSize: 18,
    color: '#FFFFFF',
  },
});
