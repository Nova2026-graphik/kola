-- File d'attente des notifications (#58)
--
-- Le pont entre l'écriture d'un message et le téléphone du destinataire. Deux
-- décisions structurent ce fichier, et toutes deux vont à l'encontre de la
-- solution évidente.
--
-- **Une ligne par CONVERSATION, pas par destinataire.** Le trigger s'exécute
-- dans la transaction d'insertion du message : y résoudre les destinataires
-- ferait payer à l'expéditeur deux cents insertions pour un message envoyé dans
-- un groupe de deux cents personnes. Le chemin d'écriture reste donc en O(1), et
-- les destinataires sont résolus au moment de l'envoi.
--
-- Ce n'est pas qu'une question de coût : c'est aussi plus juste. Une mise en
-- sourdine posée entre l'écriture et l'envoi est respectée, et quelqu'un qui
-- lit la conversation pendant ces quelques secondes ne reçoit rien.
--
-- **La résolution des destinataires reste en SQL.** La fonction Edge s'exécute
-- avec la clé de service : elle contourne RLS, et rien ne l'empêcherait
-- d'envoyer un aperçu de message à quelqu'un qui n'y a pas droit. Elle ne
-- décide donc de rien — elle appelle `claim_notifications()`, qui applique les
-- mêmes règles d'appartenance et de blocage que les policies. La fonction Edge
-- ne fait que poster vers Expo ce que la base lui rend.

create table public.notification_queue (
  conversation_id uuid primary key references public.conversations (id) on delete cascade,
  pending_count   int  not null default 0,
  last_message_id uuid references public.messages (id) on delete cascade,
  last_sender_id  uuid references public.profiles (id) on delete set null,
  first_queued_at timestamptz not null default now(),
  last_queued_at  timestamptz not null default now()
);

alter table public.notification_queue enable row level security;

-- Aucune policy : seules les fonctions SECURITY DEFINER y touchent. Une table
-- sans policy et avec RLS activée est inaccessible à `anon` comme à
-- `authenticated`, ce qui est exactement l'intention.
comment on table public.notification_queue is
  'Une ligne par conversation en attente de notification. Les destinataires sont '
  'résolus à l''envoi, pas à l''écriture (#58).';

-- ---------------------------------------------------------------------------
-- Mise en file
-- ---------------------------------------------------------------------------

create or replace function public.enqueue_notification()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  -- Jamais pour un message système : personne n'a besoin d'être réveillé parce
  -- qu'un titre de groupe a changé (#58).
  if new.kind = 'system' then
    return new;
  end if;

  insert into public.notification_queue as q
    (conversation_id, pending_count, last_message_id, last_sender_id)
  values (new.conversation_id, 1, new.id, new.sender_id)
  on conflict (conversation_id) do update
    set pending_count   = q.pending_count + 1,
        last_message_id = excluded.last_message_id,
        last_sender_id  = excluded.last_sender_id,
        last_queued_at  = now();

  return new;
end;
$$;

revoke all on function public.enqueue_notification() from public, anon, authenticated;

create trigger messages_enqueue_notification
  after insert on public.messages
  for each row execute function public.enqueue_notification();

-- ---------------------------------------------------------------------------
-- Fenêtre de regroupement
-- ---------------------------------------------------------------------------
-- Dix messages rapprochés doivent produire UNE notification, pas dix. Chaque
-- envoi réveille la radio du téléphone : dix envois, c'est dix réveils, de la
-- batterie et des données pour un contenu que l'utilisateur aurait lu d'un
-- coup.
--
-- Deux bornes, et la seconde compte autant que la première. La fenêtre de
-- silence attend que la rafale se calme ; le plafond garantit qu'une
-- conversation où quelqu'un écrit sans arrêt finit quand même par notifier.
-- Sans plafond, un groupe très actif ne notifierait jamais.

create or replace function public.notification_window()
returns interval language sql immutable set search_path = '' as $$ select interval '10 seconds' $$;

create or replace function public.notification_max_delay()
returns interval language sql immutable set search_path = '' as $$ select interval '60 seconds' $$;

-- ---------------------------------------------------------------------------
-- Réclamation des notifications à envoyer
-- ---------------------------------------------------------------------------

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
      select nq.*, c.type, c.title as conversation_title, c.last_seq,
             m.body as last_body, m.kind as last_kind,
             p.display_name, p.username
        from public.notification_queue nq
        join public.conversations c on c.id = nq.conversation_id
        left join public.messages m on m.id = nq.last_message_id
        left join public.profiles p on p.id = nq.last_sender_id
       where nq.conversation_id = any(ready)
    ),
    destinataires as (
      select e.conversation_id,
             cm.user_id,
             e.pending_count,
             e.type,
             e.conversation_title,
             e.last_body,
             e.last_kind,
             coalesce(e.display_name, e.username, 'Quelqu''un') as sender_name,
             coalesce(pr.notification_preview, true) as preview
        from en_attente e
        join public.conversation_members cm on cm.conversation_id = e.conversation_id
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
           d.conversation_id,
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
     group by d.user_id, d.conversation_id, d.type, d.sender_name,
              d.conversation_title, d.pending_count, d.last_body, d.last_kind, d.preview
    having count(dev.push_token) filter (where dev.push_token is not null) > 0;

  -- Purge APRÈS lecture, dans la même transaction : si l'envoi échoue côté
  -- Expo, la fonction Edge réessaiera sur la base de sa propre file, pas de
  -- celle-ci. Garder les lignes ici ferait renotifier tout le monde.
  delete from public.notification_queue where conversation_id = any(ready);
end;
$$;

revoke all on function public.claim_notifications(int) from public, anon, authenticated;
revoke all on function public.notification_window()    from public, anon, authenticated;
revoke all on function public.notification_max_delay() from public, anon, authenticated;

comment on function public.claim_notifications(int) is
  'Rend les notifications prêtes à partir et vide la file. Applique appartenance, '
  'sourdine, lecture et blocage : la fonction Edge ne décide de rien (#58).';

-- ---------------------------------------------------------------------------
-- Réglage de confidentialité de l'aperçu
-- ---------------------------------------------------------------------------
-- Afficher le texte d'un message sur un écran verrouillé est un choix, pas une
-- évidence — un téléphone se partage, se prête, se consulte par-dessus l'épaule.

alter table public.profiles
  add column notification_preview boolean not null default true;

comment on column public.profiles.notification_preview is
  'Afficher le texte du message dans la notification. Désactivé, la notification '
  'annonce son existence sans révéler son contenu (#58).';

-- ---------------------------------------------------------------------------
-- Nettoyage des jetons morts
-- ---------------------------------------------------------------------------

create or replace function public.invalidate_push_tokens(tokens text[])
returns int
language sql
security definer
set search_path = ''
as $$
  with efface as (
    update public.devices set push_token = null
     where push_token = any(tokens)
    returning 1
  )
  select count(*)::int from efface;
$$;

revoke all on function public.invalidate_push_tokens(text[]) from public, anon, authenticated;

comment on function public.invalidate_push_tokens(text[]) is
  'Efface les jetons qu''Expo a signalés comme morts. Le jeton est vidé, pas la '
  'ligne : l''appareil existe toujours, il n''a simplement plus de jeton valide.';
