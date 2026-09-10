-- #15 — last_message_at, aperçu dénormalisé et compteurs de non-lus
--
-- La liste des conversations est l'écran le plus consulté de l'application.
-- Elle doit se trier par date du dernier message et afficher un badge de
-- non-lus sans lancer une agrégation sur `messages` à chaque affichage.
-- La dénormalisation par trigger est ici le bon compromis : coût constant à
-- l'écriture, lecture immédiate.

alter table public.conversations
  add column last_message_preview   text,
  add column last_message_sender_id uuid references public.profiles (id) on delete set null,
  add column last_message_kind      public.message_kind;

comment on column public.conversations.last_message_preview is
  'Aperçu TRONQUÉ côté serveur. La liste des conversations ne doit pas transférer le corps '
  'entier des derniers messages sur un réseau facturé au mégaoctet.';

-- ---------------------------------------------------------------------------
-- Mise à jour de l'aperçu
-- ---------------------------------------------------------------------------

create or replace function public.refresh_conversation_preview(target_conversation uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  preview_limit constant int := 120;
  last_message  record;
begin
  select m.body, m.sender_id, m.kind, m.created_at
    into last_message
    from public.messages m
   where m.conversation_id = target_conversation
     and m.deleted_at is null
   order by m.seq desc
   limit 1;

  update public.conversations c
     set last_message_at        = last_message.created_at,
         last_message_preview   = left(last_message.body, preview_limit),
         last_message_sender_id = last_message.sender_id,
         last_message_kind      = last_message.kind
   where c.id = target_conversation;
end;
$$;

create or replace function public.on_message_written()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  preview_limit constant int := 120;
begin
  if tg_op = 'INSERT' then
    -- Chemin rapide : le message inséré est forcément le dernier, inutile de
    -- relire la table.
    update public.conversations c
       set last_message_at        = new.created_at,
           last_message_preview   = left(new.body, preview_limit),
           last_message_sender_id = new.sender_id,
           last_message_kind      = new.kind
     where c.id = new.conversation_id;
    return new;
  end if;

  -- Sur modification ou suppression logique, l'aperçu n'est à recalculer que si
  -- le message touché était bien le dernier affiché.
  if new.deleted_at is distinct from old.deleted_at
     or new.body is distinct from old.body then
    perform public.refresh_conversation_preview(new.conversation_id);
  end if;

  return new;
end;
$$;

create trigger messages_refresh_conversation
  after insert or update of body, deleted_at on public.messages
  for each row execute function public.on_message_written();

-- ---------------------------------------------------------------------------
-- Compte de non-lus
-- ---------------------------------------------------------------------------

create or replace function public.unread_count(target_conversation uuid)
returns bigint
language sql
security definer
stable
set search_path = ''
as $$
  -- Se déduit de last_read_seq et du dernier seq attribué : aucune agrégation
  -- sur `messages`, donc coût constant quelle que soit la taille de l'historique.
  select greatest(
    coalesce(c.last_seq, 0) - coalesce(m.last_read_seq, 0),
    0
  )::bigint
    from public.conversations c
    join public.conversation_members m
      on m.conversation_id = c.id
     and m.user_id = (select auth.uid())
   where c.id = unread_count.target_conversation;
$$;

comment on function public.unread_count(uuid) is
  'Non-lus d''une conversation pour l''utilisateur courant, sans agrégation sur messages.';

-- Vue d'ensemble pour la liste des conversations (#29).
create or replace view public.conversation_overview
with (security_invoker = true)
as
  select c.id,
         c.type,
         c.title,
         c.avatar_url,
         c.owner_id,
         c.community_id,
         c.last_message_at,
         c.last_message_preview,
         c.last_message_sender_id,
         c.last_message_kind,
         c.last_seq,
         m.role,
         m.last_read_seq,
         m.muted_until,
         m.pinned_at,
         m.archived_at,
         greatest(c.last_seq - m.last_read_seq, 0) as unread_count
    from public.conversations c
    join public.conversation_members m
      on m.conversation_id = c.id
   where m.user_id = (select auth.uid());

comment on view public.conversation_overview is
  'Liste des conversations de l''utilisateur courant, non-lus inclus. '
  'security_invoker : la vue respecte les policies de l''appelant, elle ne les contourne pas.';

-- ---------------------------------------------------------------------------
-- Marquage comme lu
-- ---------------------------------------------------------------------------

create or replace function public.mark_conversation_read(
  target_conversation uuid,
  up_to_seq bigint
)
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  new_seq bigint;
begin
  if not public.is_member(target_conversation) then
    raise exception 'accès refusé à cette conversation'
      using errcode = 'insufficient_privilege';
  end if;

  -- `greatest` rend l'avancement monotone : un accusé en retard, arrivé après
  -- une salve de synchronisation, ne doit jamais faire reculer le curseur de
  -- lecture et ressusciter des non-lus déjà vus.
  update public.conversation_members m
     set last_read_seq = greatest(m.last_read_seq, up_to_seq)
   where m.conversation_id = target_conversation
     and m.user_id = (select auth.uid())
  returning m.last_read_seq into new_seq;

  return new_seq;
end;
$$;

comment on function public.mark_conversation_read(uuid, bigint) is
  'Avance last_read_seq de façon monotone. Ne recule jamais.';

-- Voir la note de la migration 20260910120006 : anon reçoit EXECUTE par
-- default privileges, il faut le révoquer nommément.
revoke all on function public.mark_conversation_read(uuid, bigint) from public, anon;
revoke all on function public.unread_count(uuid)                   from public, anon;
revoke all on function public.refresh_conversation_preview(uuid)   from public, anon, authenticated;

grant execute on function public.mark_conversation_read(uuid, bigint) to authenticated;
grant execute on function public.unread_count(uuid)                   to authenticated;

revoke all on public.conversation_overview from anon;
grant select on public.conversation_overview to authenticated;
