import { useMemo } from 'react';

import { hasClient, sendEmailOtp, sendPhoneOtp, verifyOtp } from '@kola/api';

import type { OtpChannel, OtpFlowPort } from './useOtpFlow';

/**
 * Branche le parcours OTP sur le transport réel.
 *
 * L'indirection existe pour que `useOtpFlow` soit testable sans réseau : c'est
 * lui qui porte la limitation de débit, le compte à rebours et la validation,
 * c'est-à-dire tout ce qui peut se casser en silence.
 *
 * Quand aucun client n'est configuré — le cas tant que le projet Supabase n'est
 * pas câblé (#7) — les appels échouent proprement en « réseau » plutôt que de
 * lever une exception qui traverserait l'interface.
 */
export function useAuthPort(): OtpFlowPort {
  return useMemo<OtpFlowPort>(
    () => ({
      send: async (channel: OtpChannel) => {
        if (!hasClient()) {
          return { ok: false, error: 'network' as const };
        }
        return 'phone' in channel ? sendPhoneOtp(channel.phone) : sendEmailOtp(channel.email);
      },

      verify: async (channel: OtpChannel, code: string) => {
        if (!hasClient()) {
          return { ok: false, error: 'network' as const };
        }
        const result = await verifyOtp(channel, code);
        return { ok: result.ok, error: result.error };
      },
    }),
    [],
  );
}
