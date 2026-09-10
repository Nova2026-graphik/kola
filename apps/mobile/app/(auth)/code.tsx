import { useLocalSearchParams, useRouter } from 'expo-router';
import { useEffect, useRef } from 'react';
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

import {
  extractOtpFromMessage,
  formatCountdown,
  formatE164ForDisplay,
  isCompleteOtp,
  OTP_LENGTH,
  otpErrorMessage,
} from '@kola/core';

import { useAuthPort } from '../../src/features/auth/port';
import { useOtpFlow } from '../../src/features/auth/useOtpFlow';

/**
 * Saisie du code à usage unique (#21).
 *
 * C'est l'écran où l'on perd le plus d'utilisateurs. Chaque friction compte :
 * basculer vers l'application SMS, mémoriser six chiffres, revenir, se
 * tromper.
 *
 * D'où trois choix : la vérification part automatiquement dès le sixième
 * chiffre, sans bouton de validation ; coller un code depuis le presse-papiers
 * remplit toutes les cases ; et un code erroné laisse la saisie modifiable
 * plutôt que de tout effacer — retaper six chiffres pour une faute sur un seul
 * est exaspérant.
 */
export default function CodeScreen(): React.JSX.Element {
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const port = useAuthPort();
  const flow = useOtpFlow(port);
  const inputRef = useRef<TextInput>(null);
  // Garde contre une double vérification, pas un état d'affichage : une ref
  // évite le rendu en cascade d'un setState synchrone dans l'effet.
  const autoVerified = useRef(false);

  const { channel, value } = useLocalSearchParams<{
    channel: 'phone' | 'email';
    value: string;
  }>();

  const destination = channel === 'phone' ? formatE164ForDisplay(value ?? '') : (value ?? '');

  // Vérification automatique dès le sixième chiffre : le bouton de validation
  // est une friction de plus, pour aucun bénéfice.
  useEffect(() => {
    if (!isCompleteOtp(flow.code) || autoVerified.current || flow.step === 'verifying') {
      return;
    }
    autoVerified.current = true;
    void flow.verify().then((ok) => {
      if (ok) {
        router.replace('/profil');
      } else {
        // Le code reste modifiable : une nouvelle saisie relance la
        // vérification.
        autoVerified.current = false;
      }
    });
  }, [flow, router]);

  const cells = Array.from({ length: OTP_LENGTH }, (_, index) => flow.code[index] ?? '');

  return (
    <KeyboardAvoidingView
      style={styles.container}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <View style={[styles.content, { paddingTop: insets.top + 32 }]}>
        <Text style={styles.title}>Entrez le code</Text>
        <Text style={styles.subtitle}>
          Nous l’avons envoyé au {destination}. Il comporte {OTP_LENGTH} chiffres.
        </Text>

        {/* Un champ unique invisible derrière les cases : le lecteur d'écran
            annonce alors « code à six chiffres » plutôt que six champs sans
            rapport les uns avec les autres (#64). */}
        <Pressable
          style={styles.cells}
          onPress={() => {
            inputRef.current?.focus();
          }}
          accessibilityRole="none"
        >
          {cells.map((digit, index) => (
            <View
              key={index}
              style={[styles.cell, digit !== '' && styles.cellFilled]}
              accessibilityElementsHidden
              importantForAccessibility="no-hide-descendants"
            >
              <Text style={styles.digit}>{digit}</Text>
            </View>
          ))}
        </Pressable>

        <TextInput
          ref={inputRef}
          style={styles.hiddenInput}
          value={flow.code}
          onChangeText={flow.setCode}
          keyboardType="number-pad"
          maxLength={OTP_LENGTH}
          autoFocus
          // Renseigne automatiquement le code sur les deux plateformes : sur
          // iOS via la suggestion du clavier, sur Android via l'autofill.
          textContentType="oneTimeCode"
          autoComplete="one-time-code"
          accessibilityLabel={`Code de vérification à ${String(OTP_LENGTH)} chiffres`}
        />

        {flow.error !== null ? (
          <Text style={styles.error} accessibilityLiveRegion="assertive">
            {otpErrorMessage(flow.error)}
          </Text>
        ) : null}

        {flow.step === 'verifying' ? <Text style={styles.status}>Vérification…</Text> : null}

        <Pressable
          style={styles.resend}
          onPress={() => {
            void flow.resend();
          }}
          disabled={!flow.canResendNow}
          accessibilityRole="button"
          accessibilityLabel={
            flow.canResendNow
              ? 'Renvoyer le code'
              : `Renvoi possible dans ${formatCountdown(flow.secondsBeforeResend)}`
          }
          accessibilityState={{ disabled: !flow.canResendNow }}
        >
          <Text style={[styles.resendText, !flow.canResendNow && styles.resendTextDisabled]}>
            {flow.canResendNow
              ? 'Renvoyer le code'
              : `Renvoyer dans ${formatCountdown(flow.secondsBeforeResend)}`}
          </Text>
        </Pressable>

        <Pressable
          style={styles.back}
          onPress={() => {
            router.back();
          }}
          accessibilityRole="button"
        >
          <Text style={styles.backText}>Modifier le numéro</Text>
        </Pressable>
      </View>
    </KeyboardAvoidingView>
  );
}

/** Exporté pour la lecture automatique du SMS sur Android (#21). */
export { extractOtpFromMessage };

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#FFFFFF' },
  content: { flex: 1, paddingHorizontal: 24, gap: 16 },
  title: { fontSize: 26, fontWeight: '700', color: '#1A1A1A' },
  subtitle: { fontSize: 15, lineHeight: 21, color: '#6A6A6A' },
  cells: { flexDirection: 'row', gap: 8, marginTop: 16 },
  cell: {
    flex: 1,
    height: 56,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#F2EFEC',
    borderWidth: 2,
    borderColor: 'transparent',
  },
  cellFilled: { borderColor: '#A8402C' },
  digit: { fontSize: 22, fontWeight: '600', color: '#1A1A1A' },
  hiddenInput: {
    position: 'absolute',
    opacity: 0,
    height: 1,
    width: 1,
  },
  error: { fontSize: 14, color: '#A8402C' },
  status: { fontSize: 14, color: '#6A6A6A' },
  resend: { minHeight: 44, justifyContent: 'center' },
  resendText: { fontSize: 15, color: '#A8402C' },
  resendTextDisabled: { color: '#8A8A8A' },
  back: { minHeight: 44, justifyContent: 'center' },
  backText: { fontSize: 15, color: '#6A6A6A' },
});
