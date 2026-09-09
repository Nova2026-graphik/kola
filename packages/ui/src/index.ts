/**
 * Design system de Kola.
 *
 * Les tokens et les composants arrivent en #61 et #62. Ce paquet reste volontairement
 * sans dépendance React Native tant que l'application Expo (#3) n'existe pas :
 * il doit pouvoir passer le typecheck seul.
 */

/** Zone tactile minimale, en points. En dessous, la cible devient inatteignable au doigt. */
export const MIN_TOUCH_TARGET = 44;

/** Échelle d'espacement de base, en points. */
export const SPACING = [0, 4, 8, 12, 16, 24, 32, 48] as const;

export type SpacingStep = (typeof SPACING)[number];
