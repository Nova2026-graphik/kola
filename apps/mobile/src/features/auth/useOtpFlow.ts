import { useCallback, useRef, useState } from 'react';

import {
  canResend,
  EMPTY_OTP_STATE,
  isCompleteOtp,
  requestOtp,
  sanitizeOtp,
  secondsUntilResend,
  type OtpError,
  type OtpRequestState,
} from '@kola/core';

import { useNow } from '../../hooks/useNow';

/**
 * Parcours de vérification par code (#19, #20, #21).
 *
 * Toute la logique de limitation, de compte à rebours et de validation vient de
 * `@kola/core`, où elle est testée. Ce hook ne fait que la relier à l'écran et
 * au transport.
 */

export type OtpChannel = { readonly phone: string } | { readonly email: string };

export interface OtpFlowPort {
  readonly send: (channel: OtpChannel) => Promise<{ ok: boolean; error?: OtpError | undefined }>;
  readonly verify: (
    channel: OtpChannel,
    code: string,
  ) => Promise<{ ok: boolean; error?: OtpError | undefined }>;
}

export type OtpStep = 'idle' | 'sending' | 'awaiting-code' | 'verifying' | 'verified';

export interface UseOtpFlowResult {
  readonly step: OtpStep;
  readonly code: string;
  readonly error: OtpError | null;
  readonly secondsBeforeResend: number;
  readonly canResendNow: boolean;
  readonly setCode: (next: string) => void;
  readonly send: (channel: OtpChannel) => Promise<boolean>;
  readonly resend: () => Promise<boolean>;
  readonly verify: () => Promise<boolean>;
  readonly reset: () => void;
}

export function useOtpFlow(port: OtpFlowPort): UseOtpFlowResult {
  const now = useNow(1_000);
  const [step, setStep] = useState<OtpStep>('idle');
  const [code, setCodeState] = useState('');
  const [error, setError] = useState<OtpError | null>(null);
  const [availableAt, setAvailableAt] = useState(0);

  const rateState = useRef<OtpRequestState>(EMPTY_OTP_STATE);
  const channelRef = useRef<OtpChannel | null>(null);

  const send = useCallback(
    async (channel: OtpChannel): Promise<boolean> => {
      const decision = requestOtp(rateState.current, Date.now());
      rateState.current = decision.state;

      if (!decision.allowed) {
        // Retour immédiat plutôt qu'un aller-retour réseau voué à l'échec :
        // chaque SMS a un coût réel (#67).
        setAvailableAt(decision.availableAt);
        setError('too-many-attempts');
        return false;
      }

      channelRef.current = channel;
      setError(null);
      setStep('sending');

      const result = await port.send(channel);

      if (!result.ok) {
        setStep('idle');
        setError(result.error ?? 'unknown');
        return false;
      }

      setAvailableAt(decision.availableAt);
      setStep('awaiting-code');
      return true;
    },
    [port],
  );

  const resend = useCallback(async (): Promise<boolean> => {
    const channel = channelRef.current;
    if (channel === null || !canResend(availableAt, Date.now())) {
      return false;
    }
    setCodeState('');
    return send(channel);
  }, [availableAt, send]);

  const setCode = useCallback((next: string) => {
    // Un code collé depuis un SMS traîne souvent des espaces ou des tirets.
    setCodeState(sanitizeOtp(next));
    setError(null);
  }, []);

  const verify = useCallback(async (): Promise<boolean> => {
    const channel = channelRef.current;
    if (channel === null) {
      return false;
    }
    if (!isCompleteOtp(code)) {
      setError('incomplete');
      return false;
    }

    setStep('verifying');
    const result = await port.verify(channel, code);

    if (!result.ok) {
      // Le code reste modifiable : tout effacer obligerait à le retaper en
      // entier pour une faute sur un chiffre.
      setStep('awaiting-code');
      setError(result.error ?? 'unknown');
      return false;
    }

    setStep('verified');
    return true;
  }, [code, port]);

  const reset = useCallback(() => {
    setStep('idle');
    setCodeState('');
    setError(null);
    setAvailableAt(0);
    channelRef.current = null;
  }, []);

  return {
    step,
    code,
    error,
    secondsBeforeResend: secondsUntilResend(availableAt, now),
    canResendNow: canResend(availableAt, now) && step === 'awaiting-code',
    setCode,
    send,
    resend,
    verify,
    reset,
  };
}
