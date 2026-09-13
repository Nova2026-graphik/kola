-- Correctif : `conversation_id` était ambigu dans la purge de la file
--
--   ERROR 42702: column reference "conversation_id" is ambiguous
--   DETAIL: It could refer to either a PL/pgSQL variable or a table column.
--
-- `claim_notifications` déclare `returns table (..., conversation_id uuid, ...)`.
-- Ces colonnes de sortie sont, pour plpgsql, des VARIABLES de la fonction. Le
-- `delete from public.notification_queue where conversation_id = any(ready)`
-- n'était donc pas une référence à la colonne de la table mais une collision, et
-- PostgreSQL refusait de trancher.
--
-- Conséquence : la fonction levait à chaque appel, juste après avoir calculé les
-- notifications à envoyer. Aucune notification ne serait jamais partie.
--
-- Le défaut ne se voyait ni à la création — plpgsql ne valide pas les requêtes
-- d'un corps de fonction — ni à la relecture, où le `where conversation_id`
-- paraît parfaitement ordinaire. Il a fallu appeler la fonction sur des données
-- réelles pour qu'il apparaisse.
--
-- La table est désormais aliasée partout où une colonne porte le nom d'une
-- sortie.

create or replace function public.claim_notifications(batch_size int default 100)
returns table (
  recipient_id    uuid,
  conversation_id uuid,
  push_tokens     text[],
  title           text,
  body            text,
  message_count   int,
  show_preview    boolean
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  ready uuid[];
begin
  -- `skip locked` : deux exécutions concurrentes de la fonction Edge ne
  -- réclament jamais la même conversation, donc personne ne reçoit deux fois la
  -- même notification.
  select array_agg(q.conversation_id) into ready
    from (
      select nq.conversation_id
        from public.notification_queue nq
       where nq.last_queued_at  < now() - public.notification_window()
          or nq.first_queued_at < now() - public.notification_max_delay()
       order by nq.first_queued_at
       limit batch_size
       for update skip locked
    ) q;

  if ready is null then
    return;
  end if;

  return query
    with en_attente as (
      select nq.conversation_id as conv_id,
             nq.pending_count,
             nq.last_sender_id,
             c.type,
             c.title as conversation_title,
             c.last_seq,
             m.body as last_body,
             m.kind as last_kind,
             p.display_name,
             p.username
        from public.notification_queue nq
        join public.conversations c on c.id = nq.conversation_id
        left join public.messages m on m.id = nq.last_message_id
        left join public.profiles p on p.id = nq.last_sender_id
       where nq.conversation_id = any(ready)
    ),
    destinataires as (
      select e.conv_id,
             cm.user_id,
             e.pending_count,
             e.type,
             e.conversation_title,
             e.last_body,
             e.last_kind,
             coalesce(e.display_name, e.username, 'Quelqu''un') as sender_name,
             coalesce(pr.notification_preview, true) as preview
        from en_attente e
        join public.conversation_members cm on cm.conversation_id = e.conv_id
        left join public.profiles pr on pr.id = cm.user_id
       where cm.user_id is distinct from e.last_sender_id
         -- Sourdine active : évaluée ICI et non à l'écriture, pour qu'une
         -- sourdine posée entre les deux soit respectée.
         and (cm.muted_until is null or cm.muted_until <= now())
         -- Déjà lu : quelqu'un qui a la conversation ouverte n'a pas besoin
         -- d'être notifié de ce qu'il vient de voir.
         and cm.last_read_seq < e.last_seq
         -- Blocage, dans les deux sens. La fonction Edge contourne RLS : si
         -- cette règle n'est pas appliquée ici, elle ne l'est nulle part.
         and not exists (
           select 1 from public.blocks b
            where (b.blocker_id = cm.user_id and b.blocked_id = e.last_sender_id)
               or (b.blocker_id = e.last_sender_id and b.blocked_id = cm.user_id)
         )
    )
    select d.user_id,
           d.conv_id,
           array_agg(dev.push_token) filter (where dev.push_token is not null),
           case when d.type = 'dm' then d.sender_name
                else coalesce(d.conversation_title, 'Groupe') end,
           case
             when not d.preview then
               case when d.pending_count > 1
                    then d.pending_count || ' nouveaux messages'
                    else 'Nouveau message' end
             when d.pending_count > 1 then
               d.sender_name || ' · ' || d.pending_count || ' nouveaux messages'
             when d.last_kind <> 'text' then
               d.sender_name || ' a envoyé une pièce jointe'
             when d.type = 'dm' then left(coalesce(d.last_body, ''), 120)
             else d.sender_name || ' : ' || left(coalesce(d.last_body, ''), 120)
           end,
           d.pending_count,
           d.preview
      from destinataires d
      join public.devices dev on dev.user_id = d.user_id
     group by d.user_id, d.conv_id, d.type, d.sender_name,
              d.conversation_title, d.pending_count, d.last_body, d.last_kind, d.preview
    having count(dev.push_token) filter (where dev.push_token is not null) > 0;

  -- Purge APRÈS lecture, dans la même transaction. La table est aliasée : sans
  -- l'alias, `conversation_id` désigne la colonne de sortie de la fonction et
  -- PostgreSQL refuse de trancher.
  delete from public.notification_queue nq where nq.conversation_id = any(ready);
end;
$$;

revoke all on function public.claim_notifications(int) from public, anon, authenticated;
