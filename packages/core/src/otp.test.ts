import { describe, expect, it } from 'vitest';

import {
  canResend,
  EMPTY_OTP_STATE,
  extractOtpFromMessage,
  formatCountdown,
  isCompleteOtp,
  MAX_REQUESTS_PER_WINDOW,
  otpErrorMessage,
  RATE_WINDOW_MS,
  requestOtp,
  resendDelayMs,
  sanitizeOtp,
  secondsUntilResend,
} from './otp';

const NOW = 1_767_225_600_000;

describe('saisie du code', () => {
  it('ne garde que les chiffres', () => {
    // Un code collé depuis un SMS traîne souvent des espaces ou des tirets.
    expect(sanitizeOtp('12 34 56')).toBe('123456');
    expect(sanitizeOtp('12-34-56')).toBe('123456');
  });

  it('tronque au-delà de six chiffres', () => {
    expect(sanitizeOtp('1234567890')).toBe('123456');
  });

  it('reconnaît un code complet', () => {
    expect(isCompleteOtp('123456')).toBe(true);
    expect(isCompleteOtp('12345')).toBe(false);
    expect(isCompleteOtp('')).toBe(false);
  });

  it('accepte un code complet malgré la mise en forme', () => {
    expect(isCompleteOtp('123 456')).toBe(true);
  });
});

describe('extraction depuis un SMS', () => {
  it('trouve le code dans un message courant', () => {
    expect(extractOtpFromMessage('Votre code Kola est 482913. Il expire dans 5 minutes.')).toBe(
      '482913',
    );
  });

  it('trouve un code en fin de message', () => {
    expect(extractOtpFromMessage('Code : 000123')).toBe('000123');
  });

  it('ignore un numéro de téléphone présent dans le message', () => {
    // Le piège : une suite de huit chiffres contient six chiffres. Sans la
    // garde, on saisirait un morceau de numéro à la place du code.
    expect(extractOtpFromMessage('Appelez le 90123456 — code 482913')).toBe('482913');
  });

  it('ignore une suite trop longue', () => {
    expect(extractOtpFromMessage('Référence 1234567890')).toBeNull();
  });

  it('ne trouve rien quand il n’y a rien', () => {
    expect(extractOtpFromMessage('Bonjour, pas de code ici.')).toBeNull();
    expect(extractOtpFromMessage('')).toBeNull();
  });
});

describe('délai avant renvoi', () => {
  it('reste court à la première demande', () => {
    // Un SMS qui tarde est un cas normal sur ce réseau : l'utilisateur ne doit
    // pas se sentir puni.
    expect(resendDelayMs(0)).toBe(30_000);
  });

  it('croît à chaque demande', () => {
    expect(resendDelayMs(1)).toBe(60_000);
    expect(resendDelayMs(2)).toBe(120_000);
    expect(resendDelayMs(3)).toBe(300_000);
  });

  it('plafonne', () => {
    expect(resendDelayMs(50)).toBe(300_000);
  });

  it('tolère une valeur négative', () => {
    expect(resendDelayMs(-1)).toBe(30_000);
  });
});

describe('compte à rebours', () => {
  it('compte les secondes restantes', () => {
    expect(secondsUntilResend(NOW + 30_000, NOW)).toBe(30);
  });

  it('ne descend pas sous zéro', () => {
    expect(secondsUntilResend(NOW - 5_000, NOW)).toBe(0);
  });

  it('autorise le renvoi une fois le délai écoulé', () => {
    expect(canResend(NOW + 1, NOW)).toBe(false);
    expect(canResend(NOW, NOW)).toBe(true);
    expect(canResend(NOW - 1, NOW)).toBe(true);
  });

  it('affiche les secondes puis les minutes', () => {
    expect(formatCountdown(45)).toBe('45 s');
    expect(formatCountdown(60)).toBe('1:00');
    expect(formatCountdown(65)).toBe('1:05');
    expect(formatCountdown(125)).toBe('2:05');
  });

  it('traduit', () => {
    expect(formatCountdown(45, 'en')).toBe('45s');
  });
});

describe('limitation de débit', () => {
  it('autorise la première demande', () => {
    const decision = requestOtp(EMPTY_OTP_STATE, NOW);
    expect(decision.allowed).toBe(true);
    expect(decision.availableAt).toBe(NOW + 30_000);
  });

  it('espace les demandes successives', () => {
    let state = EMPTY_OTP_STATE;
    const delays: number[] = [];

    for (let i = 0; i < 3; i += 1) {
      const decision = requestOtp(state, NOW + i);
      state = decision.state;
      delays.push(decision.availableAt - (NOW + i));
    }

    expect(delays).toEqual([30_000, 60_000, 120_000]);
  });

  it('bloque au-delà du quota', () => {
    let state = EMPTY_OTP_STATE;
    for (let i = 0; i < MAX_REQUESTS_PER_WINDOW; i += 1) {
      state = requestOtp(state, NOW + i).state;
    }

    const blocked = requestOtp(state, NOW + MAX_REQUESTS_PER_WINDOW);
    // Chaque SMS a un coût réel : la demande répétée est le premier vecteur
    // d'abus (#67).
    expect(blocked.allowed).toBe(false);
    expect(blocked.availableAt).toBeGreaterThan(NOW);
  });

  it('oublie les demandes sorties de la fenêtre', () => {
    let state = EMPTY_OTP_STATE;
    for (let i = 0; i < MAX_REQUESTS_PER_WINDOW; i += 1) {
      state = requestOtp(state, NOW + i).state;
    }

    // Les cinq demandes s'échelonnent sur NOW..NOW+4 : il faut dépasser la
    // fenêtre à partir de la DERNIÈRE pour qu'elles en sortent toutes.
    const later = requestOtp(state, NOW + MAX_REQUESTS_PER_WINDOW + RATE_WINDOW_MS);
    expect(later.allowed).toBe(true);
    expect(later.state.attempts).toHaveLength(1);
  });

  it('ne compte pas les demandes refusées', () => {
    let state = EMPTY_OTP_STATE;
    for (let i = 0; i < MAX_REQUESTS_PER_WINDOW; i += 1) {
      state = requestOtp(state, NOW + i).state;
    }

    const first = requestOtp(state, NOW + 100);
    const second = requestOtp(first.state, NOW + 200);

    // Sinon l'utilisateur s'enfermerait en tapant sur un bouton inactif.
    expect(second.state.attempts).toHaveLength(MAX_REQUESTS_PER_WINDOW);
  });
});

describe('messages d’erreur', () => {
  it('ne ressemble jamais à une trace technique', () => {
    expect(otpErrorMessage('wrong-code')).toBe('Ce code ne correspond pas. Vérifiez le SMS reçu.');
  });

  it('traite l’absence de réseau comme un état normal', () => {
    // Hors ligne n'est pas une panne dans ce produit.
    expect(otpErrorMessage('network')).toContain('reconnexion');
    expect(otpErrorMessage('network')).not.toContain('Erreur');
  });

  it('couvre toutes les erreurs dans les deux langues', () => {
    const errors = [
      'incomplete',
      'wrong-code',
      'expired',
      'too-many-attempts',
      'network',
      'unknown',
    ] as const;

    for (const error of errors) {
      expect(otpErrorMessage(error, 'fr').length).toBeGreaterThan(0);
      expect(otpErrorMessage(error, 'en').length).toBeGreaterThan(0);
    }
  });
});
