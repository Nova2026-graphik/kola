import { useRouter } from 'expo-router';
import { useCallback, useState } from 'react';
import {
  KeyboardAvoidingView,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { otpErrorMessage } from '@kola/core';

import { useAuthPort } from '../../src/features/auth/port';
import { useOtpFlow } from '../../src/features/auth/useOtpFlow';

/**
 * Connexion par adresse e-mail (#20).
 *
 * Chemin de repli : il ne coûte rien par envoi, fonctionne pendant les tests de
 * l'équipe sans consommer de crédits SMS, et sert de secours quand la
 * délivrabilité SMS est mauvaise.
 */

/**
 * Validation volontairement permissive.
 *
 * Une expression rationnelle stricte rejette des adresses parfaitement valides
 * (sous-domaines, extensions longues, caractères Unicode). Le seul verdict qui
 * compte est celui du serveur de messagerie : ici on écarte les fautes de
 * frappe évidentes, rien de plus.
 */
function looksLikeEmail(value: string): boolean {
  const trimmed = value.trim();
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/u.test(trimmed);
}

export default function EmailScreen(): React.JSX.Element {
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const port = useAuthPort();
  const flow = useOtpFlow(port);
  const [email, setEmail] = useState('');

  const isValid = looksLikeEmail(email);

  const submit = useCallback(() => {
    if (!isValid) {
      return;
    }
    const address = email.trim().toLowerCase();

    void flow.send({ email: address }).then((sent) => {
      if (sent) {
        router.push({ pathname: '/code', params: { channel: 'email', value: address } });
      }
    });
  }, [email, flow, isValid, router]);

  return (
    <KeyboardAvoidingView
      style={styles.container}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <View style={[styles.content, { paddingTop: insets.top + 32 }]}>
        <Text style={styles.title}>Votre adresse e-mail</Text>
        <Text style={styles.subtitle}>
          Nous vous enverrons un code à six chiffres. Pas de lien à ouvrir : le code se saisit à la
          main, ce qui fonctionne même avec une connexion capricieuse.
        </Text>

        <TextInput
          style={styles.input}
          value={email}
          onChangeText={setEmail}
          placeholder="nom@exemple.com"
          placeholderTextColor="#8A8A8A"
          keyboardType="email-address"
          autoCapitalize="none"
          autoCorrect={false}
          autoComplete="email"
          textContentType="emailAddress"
          returnKeyType="done"
          onSubmitEditing={submit}
          accessibilityLabel="Adresse e-mail"
        />

        {flow.error !== null ? (
          <Text style={styles.error} accessibilityLiveRegion="polite">
            {otpErrorMessage(flow.error)}
          </Text>
        ) : null}

        <Pressable
          style={[styles.submit, (!isValid || flow.step === 'sending') && styles.submitDisabled]}
          onPress={submit}
          disabled={!isValid || flow.step === 'sending'}
          accessibilityRole="button"
          accessibilityLabel="Recevoir le code par e-mail"
          accessibilityState={{ disabled: !isValid || flow.step === 'sending' }}
        >
          <Text style={styles.submitText}>
            {flow.step === 'sending' ? 'Envoi…' : 'Recevoir le code'}
          </Text>
        </Pressable>

        <Pressable
          style={styles.altLink}
          onPress={() => {
            router.back();
          }}
          accessibilityRole="button"
        >
          <Text style={styles.altLinkText}>Utiliser un numéro de téléphone</Text>
        </Pressable>
      </View>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#FFFFFF' },
  content: { flex: 1, paddingHorizontal: 24, gap: 16 },
  title: { fontSize: 26, fontWeight: '700', color: '#1A1A1A' },
  subtitle: { fontSize: 15, lineHeight: 21, color: '#6A6A6A' },
  input: {
    height: 52,
    borderRadius: 12,
    paddingHorizontal: 14,
    backgroundColor: '#F2EFEC',
    color: '#1A1A1A',
    fontSize: 17,
    marginTop: 8,
  },
  error: { fontSize: 14, color: '#A8402C' },
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
  altLink: { alignItems: 'center', minHeight: 44, justifyContent: 'center' },
  altLinkText: { fontSize: 15, color: '#A8402C' },
});
