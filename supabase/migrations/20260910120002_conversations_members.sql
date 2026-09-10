-- #9 — conversations et conversation_members
--
-- Un même schéma sert les trois formes de conversation (dm, group, channel) :
-- une seule logique de lecture, de permissions et de synchronisation, plutôt
-- que trois. `conversation_members.last_read_seq` porte le calcul des non-lus
-- sans agrégation sur `messages`.

create type public.conversation_type as enum ('dm', 'group', 'channel');
create type public.member_role       as enum ('owner', 'admin', 'member');

-- ---------------------------------------------------------------------------
-- conversations
-- ---------------------------------------------------------------------------

create table public.conversations (
  id              uuid primary key default extensions.gen_random_uuid(),
  type            public.conversation_type not null,
  title           text,
  avatar_url      text,
  owner_id        uuid references public.profiles (id) on delete set null,
  community_id    uuid,
  last_message_at timestamptz,
  created_at      timestamptz not null default now(),

  -- Clé d'unicité des conversations directes : la paire des deux identifiants,
  -- ordonnée. Garantit qu'il n'existe jamais deux DM entre les mêmes personnes,
  -- sans dépendre d'une vérification applicative sujette aux courses.
  dm_key          text
);

comment on column public.conversations.community_id is
  'Nullable et sans table cible en V1 : prépare le jalon M12 sans migration destructive plus tard.';

alter table public.conversations
  add constraint conversations_title_required
  check (type = 'dm' or (title is not null and length(btrim(title)) between 1 and 80));

-- Le dm_key existe si et seulement si la conversation est un DM.
alter table public.conversations
  add constraint conversations_dm_key_consistency
  check ((type = 'dm') = (dm_key is not null));

create unique index conversations_dm_key_key
  on public.conversations (dm_key)
  where dm_key is not null;

create index conversations_last_message_at_idx
  on public.conversations (last_message_at desc nulls last);

create index conversations_community_id_idx
  on public.conversations (community_id)
  where community_id is not null;

-- ---------------------------------------------------------------------------
-- conversation_members
-- ---------------------------------------------------------------------------

create table public.conversation_members (
  conversation_id uuid not null references public.conversations (id) on delete cascade,
  user_id         uuid not null references public.profiles (id) on delete cascade,
  role            public.member_role not null default 'member',
  last_read_seq   bigint not null default 0,
  muted_until     timestamptz,
  pinned_at       timestamptz,
  archived_at     timestamptz,
  joined_at       timestamptz not null default now(),
  primary key (conversation_id, user_id)
);

comment on column public.conversation_members.last_read_seq is
  'Dernier seq lu. Le compte de non-lus s''en déduit sans agrégation sur messages.';

comment on column public.conversation_members.muted_until is
  'Stocké côté serveur pour que la sourdine s''applique à l''ENVOI de la notification (#58), '
  'et pas seulement à son affichage : envoyer puis masquer consommerait des données pour rien.';

create index conversation_members_user_id_idx
  on public.conversation_members (user_id);

-- ---------------------------------------------------------------------------
-- Un DM compte exactement deux membres
-- ---------------------------------------------------------------------------

create or replace function public.enforce_dm_member_limit()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  conv_type public.conversation_type;
  member_count int;
begin
  select c.type into conv_type
    from public.conversations c
   where c.id = new.conversation_id;

  if conv_type <> 'dm' then
    return new;
  end if;

  select count(*) into member_count
    from public.conversation_members m
   where m.conversation_id = new.conversation_id;

  if member_count >= 2 then
    raise exception 'une conversation directe ne peut pas compter plus de deux membres'
      using errcode = 'check_violation';
  end if;

  return new;
end;
$$;

create trigger conversation_members_dm_limit
  before insert on public.conversation_members
  for each row execute function public.enforce_dm_member_limit();

-- ---------------------------------------------------------------------------
-- Ouverture idempotente d'une conversation directe
-- ---------------------------------------------------------------------------

create or replace function public.get_or_create_dm(other_user_id uuid)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  me           uuid := auth.uid();
  pair_key     text;
  conversation uuid;
begin
  if me is null then
    raise exception 'authentification requise' using errcode = '28000';
  end if;

  if other_user_id is null or other_user_id = me then
    raise exception 'destinataire invalide' using errcode = 'check_violation';
  end if;

  if not exists (select 1 from public.profiles p where p.id = other_user_id) then
    raise exception 'destinataire inconnu' using errcode = 'foreign_key_violation';
  end if;

  -- Paire ordonnée : l'ordre d'appel ne doit pas produire deux conversations.
  pair_key := least(me::text, other_user_id::text) || ':' || greatest(me::text, other_user_id::text);

  select c.id into conversation
    from public.conversations c
   where c.dm_key = pair_key;

  if conversation is not null then
    return conversation;
  end if;

  insert into public.conversations (type, dm_key, owner_id)
  values ('dm', pair_key, me)
  -- Deux appels concurrents : le perdant récupère la ligne du gagnant plutôt
  -- que d'échouer sur la contrainte d'unicité.
  on conflict (dm_key) where dm_key is not null do nothing
  returning id into conversation;

  if conversation is null then
    select c.id into conversation
      from public.conversations c
     where c.dm_key = pair_key;
    return conversation;
  end if;

  insert into public.conversation_members (conversation_id, user_id, role)
  values (conversation, me, 'owner'), (conversation, other_user_id, 'member');

  return conversation;
end;
$$;

comment on function public.get_or_create_dm(uuid) is
  'Ouvre ou retrouve la conversation directe avec un autre utilisateur. Idempotente.';

-- `revoke from public` ne suffit pas : Supabase accorde EXECUTE à anon,
-- authenticated et service_role sur toute nouvelle fonction du schéma public,
-- via ALTER DEFAULT PRIVILEGES. Le grant à anon est donc explicite et survit au
-- revoke sur PUBLIC — il faut le retirer nommément.
revoke all on function public.get_or_create_dm(uuid) from public, anon;
grant execute on function public.get_or_create_dm(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------------

alter table public.conversations        enable row level security;
alter table public.conversation_members enable row level security;
