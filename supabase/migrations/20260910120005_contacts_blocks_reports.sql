-- #12 — contacts, blocks, reports
--
-- Le blocage et le signalement ne sont pas des fonctionnalités de confort :
-- sans eux, l'application est refusée par l'App Store au titre de la règle 1.2
-- sur le contenu généré par les utilisateurs. Ils sont créés dès le premier
-- jalon de données parce que le blocage doit filtrer la LECTURE des messages
-- elle-même, donc peser sur les policies RLS (#14).

create type public.report_status as enum ('open', 'reviewing', 'actioned', 'dismissed');
create type public.report_target as enum ('message', 'profile', 'conversation');
create type public.contact_source as enum ('address_book', 'username_search', 'invite_link');

-- ---------------------------------------------------------------------------
-- contacts
-- ---------------------------------------------------------------------------

create table public.contacts (
  user_id         uuid not null references public.profiles (id) on delete cascade,
  contact_user_id uuid not null references public.profiles (id) on delete cascade,
  phone_hash      text,
  source          public.contact_source not null default 'address_book',
  created_at      timestamptz not null default now(),
  primary key (user_id, contact_user_id)
);

comment on column public.contacts.phone_hash is
  'HMAC du numéro avec un poivre serveur, jamais le numéro en clair et jamais un simple '
  'SHA-256 : l''espace des numéros togolais s''énumère exhaustivement en quelques secondes. '
  'Mécanisme complet en #68.';

alter table public.contacts
  add constraint contacts_no_self
  check (user_id <> contact_user_id);

create index contacts_contact_user_id_idx on public.contacts (contact_user_id);

-- ---------------------------------------------------------------------------
-- blocks
-- ---------------------------------------------------------------------------

create table public.blocks (
  blocker_id uuid not null references public.profiles (id) on delete cascade,
  blocked_id uuid not null references public.profiles (id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (blocker_id, blocked_id)
);

comment on table public.blocks is
  'Consultée par les policies RLS de messages : l''index sur blocked_id est sur le '
  'chemin critique de chaque lecture.';

alter table public.blocks
  add constraint blocks_no_self
  check (blocker_id <> blocked_id);

create index blocks_blocked_id_idx on public.blocks (blocked_id);

-- ---------------------------------------------------------------------------
-- reports
-- ---------------------------------------------------------------------------

create table public.reports (
  id             uuid primary key default extensions.gen_random_uuid(),
  reporter_id    uuid references public.profiles (id) on delete set null,
  target_type    public.report_target not null,
  target_id      uuid not null,
  reason         text not null,
  -- Copie du contenu incriminé au moment du signalement : sans elle, la
  -- suppression du message rendrait la modération impossible (#65).
  content_snapshot text,
  status         public.report_status not null default 'open',
  reviewed_by    uuid references public.profiles (id) on delete set null,
  reviewed_at    timestamptz,
  created_at     timestamptz not null default now()
);

alter table public.reports
  add constraint reports_reason_length
  check (length(btrim(reason)) between 1 and 1000);

alter table public.reports
  add constraint reports_reviewed_consistency
  check ((status in ('open', 'reviewing')) or reviewed_at is not null);

-- La file de modération se lit par statut et par ancienneté : l'engagement de
-- traitement sous 24 h (#66) impose de trouver le plus ancien signalement ouvert
-- sans parcourir la table.
create index reports_status_created_at_idx on public.reports (status, created_at);

create index reports_target_idx on public.reports (target_type, target_id);

alter table public.contacts enable row level security;
alter table public.blocks   enable row level security;
alter table public.reports  enable row level security;
