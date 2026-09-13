import { createClient } from 'jsr:@supabase/supabase-js@2';

/**
 * Envoi des notifications push (#58).
 *
 * Cette fonction s'exécute avec la clé de service : elle contourne RLS. Rien ne
 * l'empêcherait, techniquement, d'envoyer l'aperçu d'un message privé à
 * n'importe qui.
 *
 * Elle ne décide donc de rien. `claim_notifications()` applique l'appartenance,
 * la sourdine, l'état de lecture et le blocage — les mêmes règles que les
 * policies, au même endroit qu'elles. Ce fichier ne fait que poster vers Expo ce
 * que la base lui rend, et lui rapporter les jetons morts.
 *
 * C'est délibéré : une règle d'accès réécrite ici finirait par diverger de celle
 * des policies, et la divergence ne se verrait qu'au moment où quelqu'un reçoit
 * un message qu'il n'aurait pas dû voir.
 */

const EXPO_ENDPOINT = 'https://exp.host/--/api/v2/push/send';

/** Expo refuse les lots de plus de cent messages. */
const TAILLE_LOT = 100;

interface Notification {
  recipient_id: string;
  conversation_id: string;
  push_tokens: string[];
  title: string;
  body: string;
  message_count: number;
  show_preview: boolean;
}

interface TicketExpo {
  status: 'ok' | 'error';
  id?: string;
  message?: string;
  details?: { error?: string };
}

function decouper<T>(items: T[], taille: number): T[][] {
  const lots: T[][] = [];
  for (let i = 0; i < items.length; i += taille) {
    lots.push(items.slice(i, i + taille));
  }
  return lots;
}

/**
 * Construit un message Expo par jeton.
 *
 * `collapseId` vaut l'identifiant de la conversation : si une notification
 * précédente n'a pas encore été lue, celle-ci la REMPLACE au lieu de s'empiler.
 * Le regroupement temporel se fait en base ; celui-ci rattrape ce qui est déjà
 * arrivé sur l'appareil.
 */
function versExpo(notification: Notification) {
  return notification.push_tokens.map((to) => ({
    to,
    title: notification.title,
    body: notification.body,
    sound: 'default' as const,
    // Le lien profond : ouvrir la notification doit mener à LA conversation,
    // pas à l'écran d'accueil (#60).
    data: {
      conversationId: notification.conversation_id,
      messageCount: notification.message_count,
    },
    collapseId: notification.conversation_id,
    // Android regroupe par canal ; le canal est créé côté client.
    channelId: 'messages',
    priority: 'high' as const,
    // Un badge par conversation en attente plutôt que par message : c'est ce que
    // l'utilisateur compte des yeux.
    badge: notification.message_count,
  }));
}

Deno.serve(async (): Promise<Response> => {
  const url = Deno.env.get('SUPABASE_URL');
  const cle = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');

  if (url === undefined || cle === undefined) {
    // Sans clé, la fonction ne peut rien faire d'utile. Le dire franchement
    // vaut mieux qu'un 200 qui laisserait croire que les notifications partent.
    return Response.json({ erreur: 'configuration absente' }, { status: 500 });
  }

  const supabase = createClient(url, cle, { auth: { persistSession: false } });

  const { data, error } = await supabase.rpc('claim_notifications', { batch_size: 100 });

  if (error) {
    return Response.json({ erreur: error.message }, { status: 500 });
  }

  const notifications = (data ?? []) as Notification[];
  if (notifications.length === 0) {
    return Response.json({ envoyees: 0, invalides: 0 });
  }

  const messages = notifications.flatMap(versExpo);
  const jetonsMorts: string[] = [];
  let envoyees = 0;

  for (const lot of decouper(messages, TAILLE_LOT)) {
    let tickets: TicketExpo[];
    try {
      const reponse = await fetch(EXPO_ENDPOINT, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify(lot),
      });

      if (!reponse.ok) {
        // Expo est indisponible. Les entrées de file sont déjà purgées : ces
        // notifications-ci sont perdues, et c'est le bon compromis. Les
        // reproduire ferait renotifier tout le monde à la reprise, plusieurs
        // minutes après, pour des messages déjà lus entre-temps.
        console.error(`Expo a répondu ${String(reponse.status)}`);
        continue;
      }

      const corps = (await reponse.json()) as { data?: TicketExpo[] };
      tickets = corps.data ?? [];
    } catch (cause) {
      console.error('envoi impossible', cause);
      continue;
    }

    tickets.forEach((ticket, index) => {
      if (ticket.status === 'ok') {
        envoyees += 1;
        return;
      }
      // `DeviceNotRegistered` est le seul cas où le jeton est définitivement
      // mort : l'application a été désinstallée, ou le jeton révoqué. Les
      // autres erreurs sont transitoires et ne doivent rien effacer.
      if (ticket.details?.error === 'DeviceNotRegistered') {
        const jeton = lot[index]?.to;
        if (jeton !== undefined) {
          jetonsMorts.push(jeton);
        }
      }
    });
  }

  if (jetonsMorts.length > 0) {
    await supabase.rpc('invalidate_push_tokens', { tokens: jetonsMorts });
  }

  return Response.json({ envoyees, invalides: jetonsMorts.length });
});
