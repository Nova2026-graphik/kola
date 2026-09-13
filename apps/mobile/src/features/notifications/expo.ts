import Constants from 'expo-constants';
import * as Notifications from 'expo-notifications';
import { Platform } from 'react-native';

import type { PermissionNotification } from '@kola/core';

import type { SystemeNotifications } from './register';

/**
 * Adaptateur entre `expo-notifications` et le contrat de `register.ts`.
 *
 * Tout ce qui touche au système vit ici, et rien d'autre. C'est le seul fichier
 * du dossier qui ne peut pas être testé sous Node — d'où sa minceur : il ne
 * contient aucune décision, seulement des traductions.
 */

/**
 * Comportement à la réception quand l'application est au premier plan.
 *
 * On n'affiche PAS de bannière : l'utilisateur est déjà dans l'application, le
 * message apparaît dans le fil, et une bannière par-dessus serait redondante.
 * Le son et le badge restent, pour signaler un message arrivé dans une autre
 * conversation que celle qu'on regarde.
 */
Notifications.setNotificationHandler({
  handleNotification: () =>
    Promise.resolve({
      shouldShowBanner: false,
      shouldShowList: true,
      shouldPlaySound: true,
      shouldSetBadge: true,
    }),
});

function traduire(
  statut: Notifications.PermissionStatus,
  peutRedemander: boolean,
): PermissionNotification {
  if (statut === 'granted') {
    return 'accordee';
  }
  // `undetermined` signifie que la boîte de dialogue n'a jamais été présentée.
  // Sur iOS, `canAskAgain` passe à false après le premier refus : c'est ce qui
  // rend le refus quasi définitif, et pourquoi le moment de la demande compte
  // autant (#57).
  return statut === 'undetermined' && peutRedemander ? 'jamais_demandee' : 'refusee';
}

/**
 * Crée le canal Android « messages ».
 *
 * Sans canal, Android 8+ n'affiche rien du tout — la notification est reçue et
 * silencieusement jetée. L'identifiant doit correspondre au `channelId` envoyé
 * par la fonction Edge.
 */
async function preparerCanalAndroid(): Promise<void> {
  if (Platform.OS !== 'android') {
    return;
  }
  await Notifications.setNotificationChannelAsync('messages', {
    name: 'Messages',
    importance: Notifications.AndroidImportance.HIGH,
    vibrationPattern: [0, 250, 250, 250],
    lockscreenVisibility: Notifications.AndroidNotificationVisibility.PRIVATE,
  });
}

export function creerSystemeNotifications(): SystemeNotifications {
  return {
    lirePermission: async () => {
      const { status, canAskAgain } = await Notifications.getPermissionsAsync();
      return traduire(status, canAskAgain);
    },

    demanderPermission: async () => {
      await preparerCanalAndroid();
      const { status, canAskAgain } = await Notifications.requestPermissionsAsync();
      return traduire(status, canAskAgain);
    },

    obtenirJeton: async () => {
      await preparerCanalAndroid();

      // L'identifiant du projet EAS est obligatoire pour obtenir un jeton :
      // c'est lui qui rattache le jeton au bon projet Expo. Son absence donne
      // une erreur peu parlante à l'exécution, autant la rendre explicite.
      const projectId =
        Constants.expoConfig?.extra?.['eas']?.projectId ?? Constants.easConfig?.projectId;

      if (typeof projectId !== 'string') {
        throw new Error(
          'identifiant de projet EAS absent : le jeton push ne peut pas être rattaché',
        );
      }

      const { data } = await Notifications.getExpoPushTokenAsync({ projectId });
      return data;
    },
  };
}

/** Le lien profond porté par la notification (#60). */
export function conversationDeLaNotification(
  reponse: Notifications.NotificationResponse,
): string | null {
  const donnees = reponse.notification.request.content.data as
    { conversationId?: unknown } | undefined;
  const id = donnees?.conversationId;
  return typeof id === 'string' ? id : null;
}
