import type { Person } from './usePeoplePicker';

/**
 * Sélection en cours, entre les deux écrans de création (#37).
 *
 * Un module plutôt qu'un paramètre de route : la liste peut compter plusieurs
 * dizaines de personnes, et `expo-router` fait passer les paramètres par l'URL.
 * Les y sérialiser exposerait des identifiants d'utilisateurs dans l'historique
 * de navigation et dans les journaux de plantage.
 *
 * La valeur est volontairement éphémère : elle ne survit pas au redémarrage de
 * l'application, et c'est ce qu'on veut — un parcours de création interrompu
 * recommence proprement plutôt que de reprendre un état à moitié oublié.
 */

let pending: readonly Person[] = [];

export function setPendingSelection(people: readonly Person[]): void {
  pending = people;
}

export function takePendingSelection(): readonly Person[] {
  return pending;
}

export function clearPendingSelection(): void {
  pending = [];
}
