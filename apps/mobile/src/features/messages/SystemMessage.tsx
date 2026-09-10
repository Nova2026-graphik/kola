import { memo } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import {
  formatSystemMessage,
  parseSystemMessage,
  SYSTEM_MESSAGE_FR,
  type MessageView,
} from '@kola/core';

/**
 * Message système : arrivée, départ, changement de titre (#41).
 *
 * Rendu centré, sans avatar ni bulle : ce n'est la parole de personne, c'est un
 * fait du groupe. Le confondre visuellement avec un message ferait croire que
 * quelqu'un a écrit « Amina a ajouté Kodjo ».
 *
 * La phrase est construite ici, à l'affichage, à partir du JSON stocké. Elle
 * n'existe nulle part en base — c'est ce qui permettra à #63 de la rendre en
 * anglais, en éwé ou en kabiyè, y compris pour les messages déjà envoyés.
 */

interface Props {
  readonly message: MessageView;
  /** Nom affichable d'une personne, ou `null` si le profil n'est pas connu. */
  readonly resolveName: (userId: string | null) => string | null;
}

function SystemMessageComponent({ message, resolveName }: Props): React.JSX.Element {
  const body = parseSystemMessage(message.body);
  const text = formatSystemMessage(
    body,
    message.senderId,
    // Le profil peut n'être pas encore synchronisé, ou le compte supprimé
    // (#25) : la phrase doit rester lisible dans les deux cas.
    (userId) => resolveName(userId) ?? 'Quelqu’un',
    SYSTEM_MESSAGE_FR,
  );

  return (
    <View style={styles.row}>
      <Text style={styles.text} accessibilityRole="text">
        {text}
      </Text>
    </View>
  );
}

export const SystemMessage = memo(SystemMessageComponent);

const styles = StyleSheet.create({
  row: {
    alignItems: 'center',
    paddingHorizontal: 24,
    paddingVertical: 6,
  },
  text: {
    color: '#6b6560',
    fontSize: 13,
    lineHeight: 18,
    textAlign: 'center',
  },
});
