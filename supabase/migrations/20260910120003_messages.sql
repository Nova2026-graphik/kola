-- #10 — messages, idempotence par client_id et attribution du seq
--
-- Table centrale du produit, et celle qui porte les deux mécanismes qui rendent
-- Kola utilisable sur un réseau intermittent (ADR-0002) :
--
--   * `client_id` unique rend l'envoi idempotent — un renvoi après expiration de
--     délai est rejeté par la contrainte plutôt que dupliqué ;
--   * `seq` monotone par conversation rend la reprise triviale — un simple
--     `where seq > curseur`, jamais un rechargement complet.

create type public.message_kind as enum ('text', 'image', 'video', 'audio', 'file', 'system');

-- Compteur de séquence, porté par la conversation. C'est lui qui sérialise
-- l'attribution : voir assign_message_seq() plus bas.
alter table public.conversations
  add column last_seq bigint not null default 0;

comment on column public.conversations.last_seq is
  'Dernier seq attribué. Incrémenté sous verrou de ligne par assign_message_seq().';

-- ---------------------------------------------------------------------------
-- messages
-- ---------------------------------------------------------------------------

create table public.messages (
  id              uuid primary key default extensions.gen_random_uuid(),
  client_id       uuid not null,
  conversation_id uuid not null references public.conversations (id) on delete cascade,
  sender_id       uuid references public.profiles (id) on delete set null,
  seq             bigint not null,
  kind            public.message_kind not null default 'text',
  body            text,
  reply_to_id     uuid references public.messages (id) on delete set null,
  edited_at       timestamptz,
  deleted_at      timestamptz,
  created_at      timestamptz not null default now()
);

comment on column public.messages.client_id is
  'UUID généré sur l''appareil AVANT tout aller-retour réseau. Rend l''envoi idempotent.';

comment on column public.messages.deleted_at is
  'Suppression LOGIQUE. Un DELETE physique creuserait un trou dans la suite des seq '
  'et casserait la reprise par curseur des clients hors ligne depuis longtemps.';

comment on column public.messages.sender_id is
  'Mis à NULL à la suppression du compte : les messages d''un groupe restent lisibles, '
  'détachés de l''identité (#25).';

-- Un message texte a forcément un corps. Un message système aussi : son contenu
-- est une charge structurée, jamais une phrase figée en français (#41).
alter table public.messages
  add constraint messages_body_required
  check (
    kind not in ('text', 'system')
    or (body is not null and length(btrim(body)) > 0)
  );

alter table public.messages
  add constraint messages_body_length
  check (body is null or length(body) <= 8192);

alter table public.messages
  add constraint messages_no_self_reply
  check (reply_to_id is null or reply_to_id <> id);

alter table public.messages
  add constraint messages_edited_after_created
  check (edited_at is null or edited_at >= created_at);

-- ---------------------------------------------------------------------------
-- Index
-- ---------------------------------------------------------------------------

-- L'index qui porte l'idempotence.
create unique index messages_client_id_key
  on public.messages (client_id);

-- Le chemin de lecture d'une page de conversation.
create index messages_conversation_seq_idx
  on public.messages (conversation_id, seq desc);

-- Garantit qu'aucune collision de seq ne passe, même si le trigger était
-- contourné : la contrainte est dans la base, pas seulement dans la procédure.
create unique index messages_conversation_seq_key
  on public.messages (conversation_id, seq);

create index messages_reply_to_id_idx
  on public.messages (reply_to_id)
  where reply_to_id is not null;

create index messages_sender_id_idx
  on public.messages (sender_id);

-- ---------------------------------------------------------------------------
-- Attribution du seq
-- ---------------------------------------------------------------------------

create or replace function public.assign_message_seq()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  next_seq bigint;
begin
  -- Le point délicat est la concurrence. Un `select max(seq) + 1` sans verrou
  -- produit des collisions dès que deux messages arrivent en même temps dans la
  -- même conversation — ce qui est le cas normal quand plusieurs outbox se
  -- vident en même temps après un retour de réseau.
  --
  -- L'UPDATE ci-dessous prend un verrou sur la ligne de la conversation et
  -- sérialise donc l'attribution, sans verrouiller les autres conversations.
  update public.conversations
     set last_seq = last_seq + 1
   where id = new.conversation_id
  returning last_seq into next_seq;

  if next_seq is null then
    raise exception 'conversation introuvable : %', new.conversation_id
      using errcode = 'foreign_key_violation';
  end if;

  new.seq := next_seq;
  return new;
end;
$$;

comment on function public.assign_message_seq() is
  'Attribue un seq monotone par conversation, sous verrou de ligne. Voir ADR-0002.';

create trigger messages_assign_seq
  before insert on public.messages
  for each row execute function public.assign_message_seq();

-- ---------------------------------------------------------------------------
-- Une réponse citée reste dans sa conversation
-- ---------------------------------------------------------------------------

create or replace function public.enforce_reply_same_conversation()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.reply_to_id is null then
    return new;
  end if;

  if not exists (
    select 1 from public.messages m
     where m.id = new.reply_to_id
       and m.conversation_id = new.conversation_id
  ) then
    raise exception 'le message cité appartient à une autre conversation'
      using errcode = 'check_violation';
  end if;

  return new;
end;
$$;

create trigger messages_reply_same_conversation
  before insert or update of reply_to_id on public.messages
  for each row execute function public.enforce_reply_same_conversation();

alter table public.messages enable row level security;
