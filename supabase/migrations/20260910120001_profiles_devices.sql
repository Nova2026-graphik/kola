-- #8 — profiles et devices
--
-- `profiles` est la projection publique de `auth.users` : la seule table que les
-- autres utilisateurs peuvent lire pour afficher un nom et un avatar.
-- `devices` recense les appareils d'un compte, ce qui conditionne l'envoi des
-- notifications push (un jeton par appareil) et la gestion des sessions.

create extension if not exists pgcrypto with schema extensions;

-- ---------------------------------------------------------------------------
-- profiles
-- ---------------------------------------------------------------------------

create table public.profiles (
  id            uuid primary key references auth.users (id) on delete cascade,
  username      text,
  display_name  text,
  avatar_url    text,
  phone_e164    text,
  bio           text,
  last_seen_at  timestamptz,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

comment on table public.profiles is
  'Projection publique de auth.users. Lisible par les autres utilisateurs.';

-- `username` et `display_name` sont nullables à dessein : à l'inscription par OTP
-- SMS, seul le numéro est connu. Le profil est complété juste après (#22), et le
-- trigger de création ci-dessous doit pouvoir tolérer ce vide.
comment on column public.profiles.username is
  'Nul tant que le profil n''est pas complété (#22). Unique une fois renseigné.';

alter table public.profiles
  add constraint profiles_username_format
  check (username is null or username ~ '^[a-z0-9_]{3,24}$');

-- E.164 : un « + », un premier chiffre non nul, puis jusqu'à 14 chiffres.
alter table public.profiles
  add constraint profiles_phone_e164_format
  check (phone_e164 is null or phone_e164 ~ '^\+[1-9]\d{1,14}$');

alter table public.profiles
  add constraint profiles_display_name_length
  check (display_name is null or length(btrim(display_name)) between 1 and 64);

alter table public.profiles
  add constraint profiles_bio_length
  check (bio is null or length(bio) <= 280);

-- Unicité insensible à la casse, et seulement sur les pseudos renseignés :
-- deux profils en cours de création ne doivent pas se bloquer mutuellement.
create unique index profiles_username_lower_key
  on public.profiles (lower(username))
  where username is not null;

create unique index profiles_phone_e164_key
  on public.profiles (phone_e164)
  where phone_e164 is not null;

-- ---------------------------------------------------------------------------
-- devices
-- ---------------------------------------------------------------------------

create table public.devices (
  id           uuid primary key default extensions.gen_random_uuid(),
  user_id      uuid not null references public.profiles (id) on delete cascade,
  push_token   text,
  platform     text not null,
  app_version  text,
  last_seen_at timestamptz not null default now(),
  created_at   timestamptz not null default now()
);

comment on table public.devices is
  'Un appareil par ligne. Porte le jeton push, qui est lié à l''appareil et non au compte.';

alter table public.devices
  add constraint devices_platform_check
  check (platform in ('ios', 'android'));

-- Un jeton push est réattribué par le système à un autre appareil : l'unicité
-- évite d'envoyer deux fois la même notification. Nul tant que la permission
-- de notification n'a pas été accordée, d'où l'index partiel.
create unique index devices_push_token_key
  on public.devices (push_token)
  where push_token is not null;

create index devices_user_id_idx on public.devices (user_id);

-- ---------------------------------------------------------------------------
-- Création automatique du profil à l'inscription
-- ---------------------------------------------------------------------------

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  -- Tolère l'absence totale de métadonnées : à l'inscription par OTP SMS, seul
  -- le numéro est connu. Un échec ici ferait échouer l'inscription elle-même.
  insert into public.profiles (id, phone_e164, display_name)
  values (
    new.id,
    new.phone,
    nullif(btrim(coalesce(new.raw_user_meta_data ->> 'display_name', '')), '')
  )
  on conflict (id) do nothing;

  return new;
end;
$$;

comment on function public.handle_new_user() is
  'Crée la ligne profiles à l''inscription. SECURITY DEFINER : auth.users n''est pas accessible au client.';

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ---------------------------------------------------------------------------
-- updated_at
-- ---------------------------------------------------------------------------

create or replace function public.touch_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

create trigger profiles_touch_updated_at
  before update on public.profiles
  for each row execute function public.touch_updated_at();

-- ---------------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------------
-- Activée sans policy : à ce stade, personne ne lit rien. Les policies arrivent
-- en #14, une fois les fonctions d'appartenance disponibles (#13).

alter table public.profiles enable row level security;
alter table public.devices  enable row level security;
