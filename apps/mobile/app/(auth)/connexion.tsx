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
  COUNTRY_CALLING_CODES,
  DEFAULT_COUNTRY_CALLING_CODE,
  isLikelyMobile,
  otpErrorMessage,
  parsePhone,
  phoneErrorMessage,
  type PhoneError,
} from '@kola/core';

import { useAuthPort } from '../../src/features/auth/port';
import { useOtpFlow } from '../../src/features/auth/useOtpFlow';

/**
 * Connexion par numéro de téléphone (#19).
 *
 * Au Togo, le numéro est l'identité numérique de fait : bien plus de gens ont
 * un numéro qu'une adresse e-mail active. C'est donc le chemin principal, et
 * l'indicatif +228 est présélectionné.
 *
 * La validation est locale et immédiate : un numéro mal formé ne doit jamais
 * déclencher d'appel réseau, ni coûter un SMS.
 */
export default function ConnexionScreen(): React.JSX.Element {
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const port = useAuthPort();
  const flow = useOtpFlow(port);

  const [countryCode, setCountryCode] = useState<string>(DEFAULT_COUNTRY_CALLING_CODE);
  const [rawNumber, setRawNumber] = useState('');
  const [showCountries, setShowCountries] = useState(false);
  const [localError, setLocalError] = useState<PhoneError | null>(null);

  const parsed = useMemo(
    () => (rawNumber.trim() === '' ? null : parsePhone(rawNumber, countryCode)),
    [rawNumber, countryCode],
  );

  const isValid = parsed?.ok === true;
  const notMobile = parsed?.ok === true && !isLikelyMobile(parsed.value);

  const submit = useCallback(() => {
    const result = parsePhone(rawNumber, countryCode);

    if (!result.ok) {
      // Aucun appel réseau tant que le numéro n'est pas plausible.
      setLocalError(result.error);
      return;
    }

    setLocalError(null);
    void flow.send({ phone: result.value.e164 }).then((sent) => {
      if (sent) {
        router.push({
          pathname: '/code',
          params: { channel: 'phone', value: result.value.e164 },
        });
      }
    });
  }, [countryCode, flow, rawNumber, router]);

  const message =
    localError !== null
      ? phoneErrorMessage(localError)
      : flow.error !== null
        ? otpErrorMessage(flow.error)
        : null;

  return (
    <KeyboardAvoidingView
      style={styles.container}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <ScrollView
        contentContainerStyle={[styles.content, { paddingTop: insets.top + 32 }]}
        keyboardShouldPersistTaps="handled"
      >
        <Text style={styles.title}>Votre numéro</Text>
        <Text style={styles.subtitle}>
          Nous vous enverrons un code à six chiffres par SMS pour vérifier ce numéro.
        </Text>

        <View style={styles.field}>
          <Pressable
            style={styles.countryButton}
            onPress={() => {
              setShowCountries((current) => !current);
            }}
            accessibilityRole="button"
            accessibilityLabel={`Indicatif pays, actuellement ${countryCode}`}
          >
            <Text style={styles.countryText}>{countryCode}</Text>
            <Text style={styles.chevron}>▾</Text>
          </Pressable>

          <TextInput
            style={styles.input}
            value={rawNumber}
            onChangeText={(next) => {
              setRawNumber(next);
              setLocalError(null);
            }}
            placeholder="90 12 34 56"
            placeholderTextColor="#8A8A8A"
            keyboardType="phone-pad"
            autoComplete="tel"
            textContentType="telephoneNumber"
            returnKeyType="done"
            onSubmitEditing={submit}
            accessibilityLabel="Numéro de téléphone"
          />
        </View>

        {showCountries ? (
          <View style={styles.countryList}>
            {COUNTRY_CALLING_CODES.map((country) => (
              <Pressable
                key={country.code}
                style={styles.countryRow}
                onPress={() => {
                  setCountryCode(country.code);
                  setShowCountries(false);
                }}
                accessibilityRole="button"
                accessibilityLabel={`${country.name}, ${country.code}`}
              >
                <Text style={styles.countryRowText}>
                  {country.flag} {country.name}
                </Text>
                <Text style={styles.countryRowCode}>{country.code}</Text>
              </Pressable>
            ))}
          </View>
        ) : null}

        {message !== null ? (
          <Text style={styles.error} accessibilityLiveRegion="polite">
            {message}
          </Text>
        ) : null}

        {notMobile && message === null ? (
          // Un avertissement, jamais un blocage : les plans de numérotation
          // évoluent, et refuser un numéro valide coûte un utilisateur.
          <Text style={styles.warning}>
            Ce numéro ne ressemble pas à un mobile. Vérifiez-le si vous n’êtes pas sûr.
          </Text>
        ) : null}

        <Pressable
          style={[styles.submit, (!isValid || flow.step === 'sending') && styles.submitDisabled]}
          onPress={submit}
          disabled={!isValid || flow.step === 'sending'}
          accessibilityRole="button"
          accessibilityLabel="Recevoir le code par SMS"
          accessibilityState={{ disabled: !isValid || flow.step === 'sending' }}
        >
          <Text style={styles.submitText}>
            {flow.step === 'sending' ? 'Envoi…' : 'Recevoir le code'}
          </Text>
        </Pressable>

        <Pressable
          style={styles.altLink}
          onPress={() => {
            router.push('/email');
          }}
          accessibilityRole="button"
        >
          <Text style={styles.altLinkText}>Utiliser une adresse e-mail</Text>
        </Pressable>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#FFFFFF' },
  content: { paddingHorizontal: 24, paddingBottom: 32, gap: 16 },
  title: { fontSize: 26, fontWeight: '700', color: '#1A1A1A' },
  subtitle: { fontSize: 15, lineHeight: 21, color: '#6A6A6A' },
  field: { flexDirection: 'row', gap: 8, marginTop: 8 },
  countryButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    height: 52,
    paddingHorizontal: 14,
    borderRadius: 12,
    backgroundColor: '#F2EFEC',
  },
  countryText: { fontSize: 16, color: '#1A1A1A' },
  chevron: { fontSize: 12, color: '#8A8A8A' },
  input: {
    flex: 1,
    height: 52,
    borderRadius: 12,
    paddingHorizontal: 14,
    backgroundColor: '#F2EFEC',
    color: '#1A1A1A',
    fontSize: 17,
  },
  countryList: {
    borderRadius: 12,
    backgroundColor: '#F2EFEC',
    overflow: 'hidden',
  },
  countryRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    minHeight: 48,
    paddingHorizontal: 14,
  },
  countryRowText: { fontSize: 15, color: '#1A1A1A' },
  countryRowCode: { fontSize: 15, color: '#6A6A6A' },
  error: { fontSize: 14, color: '#A8402C' },
  warning: { fontSize: 13, color: '#7A5A2E' },
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
