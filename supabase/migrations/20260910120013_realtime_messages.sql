-- Publication Realtime des messages (#50)
--
-- Le temps réel n'est qu'une optimisation de latence. La source de vérité reste
-- la synchronisation par curseur (#53) : Realtime n'offre AUCUNE garantie de
-- livraison, et un client qui s'y fierait seul perdrait des messages en
-- silence. C'est la raison pour laquelle un événement reçu ici n'avance jamais
-- le curseur de synchronisation — voir `apps/mobile/src/sync/realtime.ts`.
--
-- Seule `messages` est publiée. Publier `conversations` ferait remonter à
-- chaque message un événement supplémentaire — l'aperçu et les compteurs sont
-- mis à jour par trigger (#15) — soit un doublement du trafic pour une
-- information que le client possède déjà dans le message lui-même.

alter publication supabase_realtime add table public.messages;

-- L'identité de réplication reste celle par défaut (la clé primaire). Passer à
-- `full` ferait transiter l'ANCIENNE version complète de la ligne à chaque
-- modification : le corps du message serait envoyé deux fois, sur un réseau
-- facturé au mégaoctet, pour une valeur que le client a déjà en base.
--
-- Conséquence assumée : les événements ne portent pas `old_record`. Le client
-- n'en a pas besoin — il applique la nouvelle version telle quelle, et la
-- suppression étant logique (ADR-0002), une suppression arrive comme une
-- modification ordinaire, pas comme un événement DELETE.

-- Vérifié sur la pile locale, un abonné membre et un abonné non membre côté à
-- côte : le membre reçoit l'insertion, la modification et la suppression
-- logique ; le non-membre ne reçoit rien. La RLS s'applique bien au canal.

comment on table public.messages is
  'Publiée dans supabase_realtime (#50). La RLS s''applique aux abonnés : un '
  'utilisateur ne reçoit que les événements des conversations dont il est '
  'membre, par la policy de lecture. Realtime accélère, il ne remplace pas la '
  'synchronisation par curseur (#53).';
