-- Rôles, permissions et réglages de groupe (#38, #39, #42)
--
-- Sans hiérarchie, un groupe de cinquante personnes devient ingouvernable et
-- vulnérable au spam.
--
-- Deux règles sont tranchées ici, et #39 demandait précisément qu'elles le
-- soient explicitement plutôt que laissées au hasard de l'implémentation.
--
--   1. **Changer un rôle est réservé au propriétaire.** Un administrateur qui
--      peut en nommer d'autres peut aussi les rétrograder : à trois
--      administrateurs, le groupe se prend un jeu de chaises musicales et le
--      propriétaire n'a aucun recours. C'est un durcissement par rapport à #14,
--      où tout administrateur le pouvait.
--
--   2. **Le propriétaire ne peut pas quitter le groupe sans transférer.**
--      L'alternative — promouvoir automatiquement le plus ancien administrateur
--      — confierait un groupe à quelqu'un qui ne l'a pas demandé, et sans qu'il
--      le sache. Le départ est donc bloqué, et un groupe ne se retrouve jamais
--      sans propriétaire.

-- ---------------------------------------------------------------------------
-- Réglages du groupe
-- ---------------------------------------------------------------------------

alter table public.conversations
  add column description text,
  add column restricted  boolean not null default false;

alter table public.conversations
  add constraint conversations_description_length
  check (description is null or length(description) <= 500);

comment on column public.conversations.restricted is
  'Mode restreint : seuls les administrateurs écrivent. Appliqué par la policy '
  'd''insertion, pas seulement par l''interface — sinon un appel direct à l''API '
  'le contournerait (#39).';

-- ---------------------------------------------------------------------------
-- La matrice, côté serveur
-- ---------------------------------------------------------------------------
-- Elle existe aussi dans `packages/core/src/permissions.ts`, parce que
-- l'interface doit savoir quoi proposer. PostgreSQL ne lit pas le TypeScript :
-- il y a donc deux copies, et deux copies dérivent toujours.
--
-- Le bloc ci-dessous est délimité par des marqueurs et lu par
-- `permissions.sql.test.ts`, qui le compare à la matrice de `@kola/core`. La
-- divergence devient une erreur de test plutôt qu'un trou de sécurité découvert
-- en production.

create table public.role_permissions (
  role       public.member_role not null,
  permission text               not null,
  primary key (role, permission)
);

alter table public.role_permissions enable row level security;

-- Table de référence, sans donnée personnelle : tout utilisateur connecté peut
-- la lire. Personne ne peut l'écrire — elle ne change que par migration.
create policy role_permissions_select on public.role_permissions
  for select to authenticated
  using (true);

-- MATRICE DES PERMISSIONS — DÉBUT
insert into public.role_permissions (role, permission) values
  ('owner',  'send_message'),
  ('owner',  'add_member'),
  ('owner',  'remove_member'),
  ('owner',  'edit_group'),
  ('owner',  'set_restricted'),
  ('owner',  'change_role'),
  ('owner',  'transfer_ownership'),
  ('owner',  'delete_group'),
  ('admin',  'send_message'),
  ('admin',  'add_member'),
  ('admin',  'remove_member'),
  ('admin',  'edit_group'),
  ('admin',  'leave'),
  ('member', 'send_message'),
  ('member', 'leave');
-- MATRICE DES PERMISSIONS — FIN

comment on table public.role_permissions is
  'Matrice des permissions (#39). Copie serveur de packages/core/src/permissions.ts ; '
  'la concordance est vérifiée par permissions.sql.test.ts.';

-- ---------------------------------------------------------------------------
-- has_permission
-- ---------------------------------------------------------------------------

create or replace function public.has_permission(conversation_id uuid, permission text)
returns boolean
language sql
security definer
stable
set search_path = ''
as $$
  select exists (
    select 1
      from public.conversation_members m
      join public.role_permissions p on p.role = m.role
     where m.conversation_id = has_permission.conversation_id
       and m.user_id = (select auth.uid())
       and p.permission = has_permission.permission
  );
$$;

revoke all on function public.has_permission(uuid, text) from public, anon;
grant execute on function public.has_permission(uuid, text) to authenticated;

comment on function public.has_permission(uuid, text) is
  'Lit la matrice plutôt que de la réécrire en dur dans chaque policy : une '
  'permission ajoutée demain n''oblige pas à revoir dix policies (#39).';

-- ---------------------------------------------------------------------------
-- Mode restreint : appliqué à l'ÉCRITURE
-- ---------------------------------------------------------------------------
-- Le critère d'acceptation de #39 est explicite : « y compris par appel direct
-- à l'API ». Une vérification côté interface ne serait qu'un confort.

drop policy messages_insert on public.messages;

create policy messages_insert on public.messages
  for insert to authenticated
  with check (
    public.is_member(conversation_id)
    and sender_id = (select auth.uid())
    and not public.is_blocked_in_conversation(conversation_id)
    and kind <> 'system'
    and (
      not (select c.restricted from public.conversations c where c.id = conversation_id)
      or public.is_admin(conversation_id)
    )
  );

-- ---------------------------------------------------------------------------
-- Modification du groupe : réservée aux administrateurs
-- ---------------------------------------------------------------------------
-- La policy d'origine (#14) laissait tout membre modifier la conversation.

drop policy if exists conversations_update on public.conversations;

create policy conversations_update on public.conversations
  for update to authenticated
  using (public.has_permission(id, 'edit_group'))
  with check (public.has_permission(id, 'edit_group'));

-- ---------------------------------------------------------------------------
-- Le drapeau du transfert de propriété
-- ---------------------------------------------------------------------------
-- Un drapeau DISTINCT de celui des messages système. La tentation était de
-- réutiliser le premier — il est déjà là, il est déjà transactionnel — et c'est
-- une faute : deux préoccupations dans un même drapeau, et le jour où l'une le
-- pose pour ses raisons, l'autre baisse sa garde. Un test de #14 l'a montré
-- immédiatement, un membre simple pouvant alors se promouvoir administrateur.
--
-- Celui-ci n'est posé que par `transfer_ownership`, qui a déjà vérifié les
-- droits, et `set local` le confine à sa transaction.

create or replace function public.ownership_transfer_in_progress()
returns boolean
language sql
stable
set search_path = ''
as $$
  select coalesce(current_setting('kola.ownership_transfer', true), 'off') = 'on';
$$;

revoke all on function public.ownership_transfer_in_progress() from public, anon, authenticated;

-- `owner_id` et `type` ne se modifient pas par UPDATE direct : le premier passe
-- par `transfer_ownership`, le second ne change jamais. Sans ce garde-fou, un
-- administrateur s'attribuerait la propriété d'un trait de plume.
create or replace function public.enforce_conversation_immutables()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.type is distinct from old.type
     or (new.owner_id is distinct from old.owner_id
         and not public.ownership_transfer_in_progress())
     or new.client_id is distinct from old.client_id
     or new.dm_key is distinct from old.dm_key then
    raise exception 'champ immuable modifié sur une conversation'
      using errcode = 'check_violation';
  end if;

  if new.restricted is distinct from old.restricted
     and not public.has_permission(new.id, 'set_restricted') then
    raise exception 'seul le propriétaire peut restreindre l''écriture'
      using errcode = 'insufficient_privilege';
  end if;

  return new;
end;
$$;

revoke all on function public.enforce_conversation_immutables() from public, anon, authenticated;

create trigger conversations_immutables_guard
  before update on public.conversations
  for each row execute function public.enforce_conversation_immutables();

-- ---------------------------------------------------------------------------
-- Changement de rôle : réservé au propriétaire
-- ---------------------------------------------------------------------------

create or replace function public.enforce_member_role_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.role is distinct from old.role then
    if public.ownership_transfer_in_progress() then
      -- `transfer_ownership` a déjà vérifié les droits, et elle seule pose ce
      -- drapeau. Les deux lignes de rôle changent ensemble : prises isolément,
      -- les règles ci-dessous refuseraient chacune d'elles.
      return new;
    end if;

    if not public.has_permission(new.conversation_id, 'change_role') then
      raise exception 'seul le propriétaire peut modifier un rôle'
        using errcode = 'insufficient_privilege';
    end if;

    -- La propriété se transfère par `transfer_ownership`, jamais par un UPDATE
    -- de rôle : sinon un groupe se retrouverait avec deux propriétaires, ou
    -- avec aucun.
    if new.role = 'owner' or old.role = 'owner' then
      raise exception 'la propriété se transfère par transfer_ownership'
        using errcode = 'check_violation';
    end if;
  end if;

  if new.conversation_id is distinct from old.conversation_id
     or new.user_id is distinct from old.user_id then
    raise exception 'la clé d''un membre est immuable'
      using errcode = 'check_violation';
  end if;

  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- Le propriétaire ne part pas
-- ---------------------------------------------------------------------------

create or replace function public.enforce_owner_stays()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  -- Suppression du groupe : la ligne de la conversation est déjà partie, et
  -- c'est la cascade qui retire les membres. Rien à protéger — il n'y a plus de
  -- groupe à laisser sans propriétaire.
  if not exists (select 1 from public.conversations c where c.id = old.conversation_id) then
    return old;
  end if;

  if old.role = 'owner'
     and exists (select 1 from public.conversations c
                  where c.id = old.conversation_id and c.type <> 'dm') then
    raise exception 'transférez la propriété avant de quitter le groupe'
      using errcode = 'check_violation';
  end if;

  return old;
end;
$$;

revoke all on function public.enforce_owner_stays() from public, anon, authenticated;

create trigger conversation_members_owner_guard
  before delete on public.conversation_members
  for each row execute function public.enforce_owner_stays();

-- ---------------------------------------------------------------------------
-- Transfert de propriété
-- ---------------------------------------------------------------------------

create or replace function public.transfer_ownership(
  target_conversation uuid,
  new_owner uuid
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  current_owner uuid := (select auth.uid());
begin
  if not public.has_permission(target_conversation, 'transfer_ownership') then
    raise exception 'seul le propriétaire peut transférer la propriété'
      using errcode = 'insufficient_privilege';
  end if;

  if new_owner = current_owner then
    raise exception 'la propriété est déjà la vôtre'
      using errcode = 'check_violation';
  end if;

  if not exists (select 1 from public.conversation_members m
                  where m.conversation_id = target_conversation
                    and m.user_id = new_owner) then
    raise exception 'le nouveau propriétaire doit être membre du groupe'
      using errcode = 'check_violation';
  end if;

  -- Les deux lignes changent ensemble, sous le drapeau : les triggers de garde
  -- refuseraient chacune prise isolément, et c'est bien ce qu'on veut d'eux.
  perform set_config('kola.ownership_transfer', 'on', true);

  update public.conversation_members
     set role = 'admin'
   where conversation_id = target_conversation and user_id = current_owner;

  update public.conversation_members
     set role = 'owner'
   where conversation_id = target_conversation and user_id = new_owner;

  update public.conversations
     set owner_id = new_owner
   where id = target_conversation;

  perform set_config('kola.ownership_transfer', 'off', true);

  perform public.emit_system_message(
    target_conversation,
    current_owner,
    jsonb_build_object('type', 'ownership_transferred', 'target', new_owner)
  );
end;
$$;

revoke all on function public.transfer_ownership(uuid, uuid) from public, anon;
grant execute on function public.transfer_ownership(uuid, uuid) to authenticated;

comment on function public.transfer_ownership(uuid, uuid) is
  'Transfère la propriété d''un groupe. Seul chemin possible : un UPDATE direct '
  'du rôle est refusé par enforce_member_role_change (#39).';

-- ---------------------------------------------------------------------------
-- Ajout de membres par un administrateur
-- ---------------------------------------------------------------------------
-- La policy d'insertion vérifiait `is_admin`. On passe par la matrice, pour que
-- la règle vive à un seul endroit.

drop policy conversation_members_insert on public.conversation_members;

create policy conversation_members_insert on public.conversation_members
  for insert to authenticated
  with check (public.has_permission(conversation_id, 'add_member'));

drop policy conversation_members_delete on public.conversation_members;

create policy conversation_members_delete on public.conversation_members
  for delete to authenticated
  using (
    -- Quitter soi-même…
    user_id = (select auth.uid())
    -- …ou être retiré par quelqu'un qui en a le droit.
    or public.has_permission(conversation_id, 'remove_member')
  );

-- ---------------------------------------------------------------------------
-- La vue expose les nouveaux réglages
-- ---------------------------------------------------------------------------
-- Les colonnes ajoutées vont EN FIN de liste : `create or replace view` refuse
-- de renommer une colonne existante, et insérer au milieu revient à renommer
-- tout ce qui suit.

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
         greatest(c.last_seq - m.last_read_seq, 0) as unread_count,
         c.last_change_seq,
         c.created_at,
         c.description,
         c.restricted
    from public.conversations c
    join public.conversation_members m
      on m.conversation_id = c.id
   where m.user_id = (select auth.uid());

revoke all on public.conversation_overview from anon;
grant select on public.conversation_overview to authenticated;
