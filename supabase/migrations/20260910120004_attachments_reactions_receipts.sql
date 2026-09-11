-- #11 — attachments, reactions, receipts
--
-- Ces trois tables complètent le message. `attachments` porte les métadonnées
-- qui permettent d'afficher une image AVANT de l'avoir téléchargée (dimensions
-- et blurhash) — décisif sur un réseau lent. `receipts` alimente les états
-- « reçu » et « lu ». `reactions` est le retour le plus léger en données.

-- ---------------------------------------------------------------------------
-- attachments
-- ---------------------------------------------------------------------------

create table public.attachments (
  id           uuid primary key default extensions.gen_random_uuid(),
  message_id   uuid not null references public.messages (id) on delete cascade,
  storage_path text not null,
  mime         text not null,
  size         bigint not null,
  width        integer,
  height       integer,
  duration_ms  integer,
  blurhash     text,
  created_at   timestamptz not null default now()
);

comment on column public.attachments.blurhash is
  'Calculé sur l''appareil à l''envoi (#43). Le serveur ne décode jamais l''image.';

alter table public.attachments
  add constraint attachments_size_range
  check (size > 0 and size <= 26214400); -- 25 Mo

-- Liste blanche de types MIME. C'est une mesure de sécurité, pas de confort :
-- une messagerie qui transporte des APK devient un vecteur de diffusion de
-- logiciels malveillants. Vérifiée ici, donc côté serveur, et pas seulement
-- dans le client où elle serait contournable (#46).
alter table public.attachments
  add constraint attachments_mime_allowlist
  check (
    mime in (
      'image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/gif',
      'video/mp4', 'video/quicktime', 'video/webm',
      'audio/mp4', 'audio/aac', 'audio/ogg', 'audio/opus', 'audio/mpeg',
      'application/pdf',
      'text/plain', 'text/csv',
      'application/msword',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'application/vnd.ms-excel',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'application/vnd.ms-powerpoint',
      'application/vnd.openxmlformats-officedocument.presentationml.presentation'
    )
  );

alter table public.attachments
  add constraint attachments_dimensions_positive
  check (
    (width  is null or width  > 0)
    and (height is null or height > 0)
    and (duration_ms is null or duration_ms > 0)
  );

create index attachments_message_id_idx on public.attachments (message_id);

-- ---------------------------------------------------------------------------
-- Un message média porte au moins une pièce jointe
-- ---------------------------------------------------------------------------
-- Contrainte différée à la fin de transaction : le message est inséré avant sa
-- pièce jointe, les deux dans la même transaction.

create or replace function public.enforce_media_has_attachment()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.kind not in ('image', 'video', 'audio', 'file') then
    return new;
  end if;

  if not exists (
    select 1 from public.attachments a where a.message_id = new.id
  ) then
    raise exception 'un message de type % doit porter au moins une pièce jointe', new.kind
      using errcode = 'check_violation';
  end if;

  return new;
end;
$$;

create constraint trigger messages_media_has_attachment
  after insert on public.messages
  deferrable initially deferred
  for each row execute function public.enforce_media_has_attachment();

-- ---------------------------------------------------------------------------
-- reactions
-- ---------------------------------------------------------------------------

create table public.reactions (
  message_id uuid not null references public.messages (id) on delete cascade,
  user_id    uuid not null references public.profiles (id) on delete cascade,
  emoji      text not null,
  created_at timestamptz not null default now(),
  primary key (message_id, user_id, emoji)
);

comment on table public.reactions is
  'La clé primaire composite garantit qu''un même emoji n''est pas posé deux fois : '
  'le client peut donc réémettre sans risque de doublon.';

alter table public.reactions
  add constraint reactions_emoji_length
  check (length(emoji) between 1 and 8);

create index reactions_user_id_idx on public.reactions (user_id);

-- ---------------------------------------------------------------------------
-- receipts
-- ---------------------------------------------------------------------------

create table public.receipts (
  message_id   uuid not null references public.messages (id) on delete cascade,
  user_id      uuid not null references public.profiles (id) on delete cascade,
  delivered_at timestamptz,
  read_at      timestamptz,
  primary key (message_id, user_id)
);

comment on table public.receipts is
  'Détail par message et par destinataire. C''est la table qui grossit le plus vite : '
  'dans un groupe de 50 membres, mille messages produisent 50 000 lignes. Au-delà d''un '
  'seuil de membres, s''appuyer sur conversation_members.last_read_seq et ne matérialiser '
  'le détail qu''à la demande — arbitrage tranché en #52.';

-- Un accusé de lecture ne peut pas précéder l'accusé de réception.
alter table public.receipts
  add constraint receipts_read_after_delivered
  check (read_at is null or (delivered_at is not null and read_at >= delivered_at));

create index receipts_user_id_idx on public.receipts (user_id);

alter table public.attachments enable row level security;
alter table public.reactions   enable row level security;
alter table public.receipts    enable row level security;
