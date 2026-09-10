-- Création de groupe atomique (#37) et messages système structurés (#41)
--
-- Le groupe est l'usage social dominant de la messagerie en Afrique de
-- l'Ouest : famille, tontine, association, équipe de travail.
--
-- Deux exigences le distinguent d'une conversation directe.
--
--   1. **La création doit être atomique.** Créer la conversation puis insérer
--      les membres en deux allers-retours laisse, si le second échoue, un
--      groupe sans membres : invisible pour tout le monde, y compris son
--      créateur, et impossible à supprimer puisque plus personne n'y a accès.
--
--   2. **Les événements de vie du groupe doivent être visibles.** Sans messages
--      système, un groupe est opaque : personne ne sait qui est arrivé, qui est
--      parti, ni pourquoi le nom a changé.

-- ---------------------------------------------------------------------------
-- Idempotence de la création
-- ---------------------------------------------------------------------------
-- Même raisonnement que pour les messages (#10) : sur un réseau qui coupe, une
-- réponse perdue est indiscernable d'un échec. Sans identifiant fourni par
-- l'appareil, la réémission créerait un second groupe — et l'utilisateur se
-- retrouverait avec deux « Tontine du quartier » à moitié peuplées.

alter table public.conversations
  add column client_id uuid;

comment on column public.conversations.client_id is
  'UUID généré sur l''appareil avant l''appel. Rend la création de groupe '
  'idempotente : une réémission après coupure retrouve le groupe déjà créé au '
  'lieu d''en fabriquer un second.';

create unique index conversations_client_id_key
  on public.conversations (client_id)
  where client_id is not null;

-- ---------------------------------------------------------------------------
-- Messages système : contenu STRUCTURÉ, jamais une phrase
-- ---------------------------------------------------------------------------
-- `{"type":"member_added","actor":"…","target":"…"}` et non « Amina a ajouté
-- Kodjo ». La phrase figée rendrait l'internationalisation (#63) impossible
-- rétroactivement : les messages déjà écrits resteraient en français chez tout
-- le monde, pour toujours. Le client traduit à l'affichage.

create or replace function public.emit_system_message(
  target_conversation uuid,
  actor uuid,
  payload jsonb
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  conversation_type public.conversation_type;
begin
  select c.type into conversation_type
    from public.conversations c
   where c.id = target_conversation;

  -- Rien à annoncer dans une conversation directe : il n'y a ni arrivée, ni
  -- départ, ni titre à changer.
  if conversation_type is null or conversation_type = 'dm' then
    return;
  end if;

  insert into public.messages (client_id, conversation_id, sender_id, kind, body)
  values (extensions.gen_random_uuid(), target_conversation, actor, 'system', payload::text);
end;
$$;

revoke all on function public.emit_system_message(uuid, uuid, jsonb) from public, anon, authenticated;

comment on function public.emit_system_message(uuid, uuid, jsonb) is
  'Insère un message système. Le corps est du JSON structuré, jamais une phrase '
  'traduite : le client traduit à l''affichage (#41, #63).';

-- ---------------------------------------------------------------------------
-- Le drapeau de silence
-- ---------------------------------------------------------------------------
-- À la création d'un groupe de cinq personnes, les triggers d'arrivée
-- produiraient cinq messages « untel a rejoint » avant même le premier mot. Un
-- seul message d'ouverture suffit.
--
-- `set local` limite le drapeau à la transaction en cours : il ne peut pas
-- fuir vers une autre requête ni rester posé après un échec.

create or replace function public.system_messages_suppressed()
returns boolean
language sql
stable
set search_path = ''
as $$
  select coalesce(current_setting('kola.suppress_system_messages', true), 'off') = 'on';
$$;

revoke all on function public.system_messages_suppressed() from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Arrivées et départs
-- ---------------------------------------------------------------------------

create or replace function public.on_member_added()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if public.system_messages_suppressed() then
    return new;
  end if;

  perform public.emit_system_message(
    new.conversation_id,
    (select auth.uid()),
    jsonb_build_object('type', 'member_added', 'target', new.user_id)
  );
  return new;
end;
$$;

create or replace function public.on_member_removed()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor uuid := (select auth.uid());
begin
  if public.system_messages_suppressed() then
    return old;
  end if;

  -- Partir de soi-même et être retiré par un administrateur ne se racontent pas
  -- de la même façon, et la policy autorise les deux (#14).
  perform public.emit_system_message(
    old.conversation_id,
    actor,
    case
      when actor is not distinct from old.user_id
        then jsonb_build_object('type', 'member_left')
      else jsonb_build_object('type', 'member_removed', 'target', old.user_id)
    end
  );
  return old;
end;
$$;

create or replace function public.on_member_role_changed()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if public.system_messages_suppressed() or new.role = old.role then
    return new;
  end if;

  perform public.emit_system_message(
    new.conversation_id,
    (select auth.uid()),
    jsonb_build_object('type', 'role_changed', 'target', new.user_id, 'role', new.role)
  );
  return new;
end;
$$;

create or replace function public.on_conversation_renamed()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if public.system_messages_suppressed() then
    return new;
  end if;

  if new.title is distinct from old.title then
    perform public.emit_system_message(
      new.id,
      (select auth.uid()),
      jsonb_build_object('type', 'title_changed', 'title', new.title)
    );
  end if;

  if new.avatar_url is distinct from old.avatar_url then
    perform public.emit_system_message(
      new.id,
      (select auth.uid()),
      jsonb_build_object('type', 'avatar_changed')
    );
  end if;

  return new;
end;
$$;

revoke all on function public.on_member_added()        from public, anon, authenticated;
revoke all on function public.on_member_removed()      from public, anon, authenticated;
revoke all on function public.on_member_role_changed() from public, anon, authenticated;
revoke all on function public.on_conversation_renamed() from public, anon, authenticated;

create trigger conversation_members_added
  after insert on public.conversation_members
  for each row execute function public.on_member_added();

create trigger conversation_members_removed
  after delete on public.conversation_members
  for each row execute function public.on_member_removed();

create trigger conversation_members_role_announced
  after update of role on public.conversation_members
  for each row execute function public.on_member_role_changed();

create trigger conversations_renamed
  after update of title, avatar_url on public.conversations
  for each row execute function public.on_conversation_renamed();

-- ---------------------------------------------------------------------------
-- Création du groupe
-- ---------------------------------------------------------------------------

create or replace function public.create_group(
  p_client_id  uuid,
  p_title      text,
  p_member_ids uuid[],
  p_avatar_url text default null
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  creator     uuid := (select auth.uid());
  existing    uuid;
  new_id      uuid;
  clean_title text := btrim(coalesce(p_title, ''));
  invitees    uuid[];
begin
  if creator is null then
    raise exception 'authentification requise'
      using errcode = 'insufficient_privilege';
  end if;

  -- Idempotence : la réémission après coupure retrouve le groupe déjà créé.
  select c.id into existing
    from public.conversations c
   where c.client_id = p_client_id;
  if existing is not null then
    return existing;
  end if;

  if length(clean_title) < 1 or length(clean_title) > 80 then
    raise exception 'le nom du groupe doit faire entre 1 et 80 caractères'
      using errcode = 'check_violation';
  end if;

  -- Les invités sont filtrés ici, pas dans le client : la liste arrive du
  -- réseau et rien ne garantit qu'elle n'a pas été fabriquée à la main.
  select coalesce(array_agg(distinct p.id), array[]::uuid[])
    into invitees
    from public.profiles p
   where p.id = any(coalesce(p_member_ids, array[]::uuid[]))
     and p.id <> creator
     -- Quelqu'un qui a bloqué le créateur ne doit pas se retrouver dans son
     -- groupe : le blocage serait contourné par une simple invitation.
     and not exists (
       select 1 from public.blocks b
        where b.blocker_id = p.id and b.blocked_id = creator
     );

  -- Tout se passe dans une seule transaction : la fonction échoue en bloc ou
  -- réussit en bloc. C'est la garantie qui manque à une création en deux appels.
  perform set_config('kola.suppress_system_messages', 'on', true);

  -- L'identifiant de la conversation EST celui fourni par l'appareil.
  --
  -- Ce n'est pas une coquetterie : l'appareil a déjà créé le groupe localement
  -- sous cet identifiant, pour que l'écran s'ouvre sans attendre le réseau. Si
  -- le serveur en attribuait un autre, il faudrait ensuite le réécrire partout
  -- — messages, brouillons, curseur de synchronisation, charges utiles encore
  -- en file — et le moindre oubli laisserait une référence orpheline.
  --
  -- Le risque est borné : `client_id` reste la clé d'idempotence, donc viser
  -- l'identifiant d'une conversation existante ne la retrouve pas ; l'insertion
  -- échoue sur la clé primaire. L'échec est fermé, pas ouvert.
  insert into public.conversations (id, type, title, avatar_url, owner_id, client_id)
  values (p_client_id, 'group', clean_title, p_avatar_url, creator, p_client_id)
  returning id into new_id;

  insert into public.conversation_members (conversation_id, user_id, role)
  values (new_id, creator, 'owner');

  insert into public.conversation_members (conversation_id, user_id, role)
  select new_id, unnest(invitees), 'member';

  perform set_config('kola.suppress_system_messages', 'off', true);

  -- Un seul message d'ouverture, plutôt qu'une arrivée par membre.
  perform public.emit_system_message(
    new_id,
    creator,
    jsonb_build_object('type', 'group_created', 'title', clean_title)
  );

  return new_id;
end;
$$;

revoke all on function public.create_group(uuid, text, uuid[], text) from public, anon;
grant execute on function public.create_group(uuid, text, uuid[], text) to authenticated;

comment on function public.create_group(uuid, text, uuid[], text) is
  'Crée un groupe et tous ses membres en une transaction. Idempotente par '
  'client_id. Le créateur est owner, les invités member (#37).';

-- ---------------------------------------------------------------------------
-- Recherche de personnes
-- ---------------------------------------------------------------------------
-- La découverte par carnet d'adresses arrive en #68. En attendant, on cherche
-- par pseudo — unique depuis #22.
--
-- La fonction ne rend QUE ce qui est nécessaire pour choisir quelqu'un, et
-- jamais le numéro de téléphone : une recherche ouverte qui rendrait les
-- numéros serait un annuaire inversé offert à qui sait taper trois lettres.

create or replace function public.search_profiles(query text, max_results int default 20)
returns table (id uuid, username text, display_name text, avatar_url text)
language sql
security definer
stable
set search_path = ''
as $$
  select p.id, p.username, p.display_name, p.avatar_url
    from public.profiles p
   where p.username is not null
     and p.id <> (select auth.uid())
     and p.username ilike '%' || btrim(query) || '%'
     -- On ne propose pas quelqu'un qui vous a bloqué.
     and not exists (
       select 1 from public.blocks b
        where b.blocker_id = p.id and b.blocked_id = (select auth.uid())
     )
   order by
     -- Le préfixe d'abord : qui tape « ko » cherche « kodjo », pas « makossa ».
     (p.username ilike btrim(query) || '%') desc,
     length(p.username),
     p.username
   limit least(greatest(coalesce(max_results, 20), 1), 50);
$$;

revoke all on function public.search_profiles(text, int) from public, anon;
grant execute on function public.search_profiles(text, int) to authenticated;

comment on function public.search_profiles(text, int) is
  'Recherche par pseudo. Ne rend jamais le numéro de téléphone : une recherche '
  'ouverte qui le rendrait serait un annuaire inversé (#37, en attendant #68).';
