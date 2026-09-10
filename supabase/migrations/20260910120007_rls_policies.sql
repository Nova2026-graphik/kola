-- #14 — policies RLS sur toutes les tables
--
-- Toute la sécurité d'accès de Kola est ici, dans la base, pas dans le code
-- client (ADR-0004). C'est ce qui permet à l'application mobile de parler
-- directement à Postgres sans couche d'API intermédiaire.
--
-- Deux règles de rédaction suivies partout :
--
--   * une policy par opération (`select`, `insert`, `update`, `delete`) plutôt
--     qu'une policy `for all` : la clause `with check` d'une insertion et la
--     clause `using` d'une lecture ne doivent presque jamais être identiques ;
--
--   * `(select auth.uid())` plutôt que `auth.uid()`, pour que Postgres évalue
--     l'appel une seule fois par requête au lieu d'une fois par ligne.
--
-- Aucune policy `for delete` sur `messages` : la suppression y est logique
-- (ADR-0002). Un DELETE physique creuserait un trou dans la suite des seq.

-- ---------------------------------------------------------------------------
-- profiles
-- ---------------------------------------------------------------------------

create policy profiles_select on public.profiles
  for select to authenticated
  -- Le profil reste lisible par tout utilisateur authentifié : c'est ce qui
  -- permet d'afficher un nom et un avatar. Sauf blocage, dans un sens ou dans
  -- l'autre.
  using (not public.is_blocked(id));

create policy profiles_insert on public.profiles
  for insert to authenticated
  with check (id = (select auth.uid()));

create policy profiles_update on public.profiles
  for update to authenticated
  using (id = (select auth.uid()))
  with check (id = (select auth.uid()));

-- ---------------------------------------------------------------------------
-- devices
-- ---------------------------------------------------------------------------

create policy devices_select on public.devices
  for select to authenticated
  using (user_id = (select auth.uid()));

create policy devices_insert on public.devices
  for insert to authenticated
  with check (user_id = (select auth.uid()));

create policy devices_update on public.devices
  for update to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

create policy devices_delete on public.devices
  for delete to authenticated
  using (user_id = (select auth.uid()));

-- ---------------------------------------------------------------------------
-- conversations
-- ---------------------------------------------------------------------------

create policy conversations_select on public.conversations
  for select to authenticated
  using (public.is_member(id));

create policy conversations_insert on public.conversations
  for insert to authenticated
  with check (owner_id = (select auth.uid()));

create policy conversations_update on public.conversations
  for update to authenticated
  using (public.is_admin(id))
  with check (public.is_admin(id));

-- Pas de policy delete : un groupe se quitte ou s'archive. Sa suppression
-- effective passera par une fonction dédiée au jalon M4 (#42).

-- ---------------------------------------------------------------------------
-- conversation_members
-- ---------------------------------------------------------------------------

create policy conversation_members_select on public.conversation_members
  for select to authenticated
  using (public.is_member(conversation_id));

create policy conversation_members_insert on public.conversation_members
  for insert to authenticated
  with check (public.is_admin(conversation_id));

-- Un membre met à jour sa propre ligne (last_read_seq, sourdine, épinglage) ;
-- un administrateur met à jour celle des autres (rôle).
--
-- RLS ne peut pas comparer l'ancienne et la nouvelle valeur d'une colonne : la
-- garantie qu'un membre simple ne se promeut pas lui-même est donc portée par
-- le trigger `enforce_member_role_change` ci-dessous, pas par la policy.
create policy conversation_members_update on public.conversation_members
  for update to authenticated
  using (user_id = (select auth.uid()) or public.is_admin(conversation_id))
  with check (user_id = (select auth.uid()) or public.is_admin(conversation_id));

create policy conversation_members_delete on public.conversation_members
  for delete to authenticated
  -- Quitter soi-même, ou être retiré par un administrateur.
  using (user_id = (select auth.uid()) or public.is_admin(conversation_id));

create or replace function public.enforce_member_role_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.role is distinct from old.role
     and not public.is_admin(new.conversation_id) then
    raise exception 'seul un administrateur peut modifier un rôle'
      using errcode = 'insufficient_privilege';
  end if;

  -- Le conversation_id et le user_id d'une ligne ne se déplacent pas.
  if new.conversation_id is distinct from old.conversation_id
     or new.user_id is distinct from old.user_id then
    raise exception 'la clé d''un membre est immuable'
      using errcode = 'check_violation';
  end if;

  return new;
end;
$$;

create trigger conversation_members_role_guard
  before update on public.conversation_members
  for each row execute function public.enforce_member_role_change();

-- ---------------------------------------------------------------------------
-- messages
-- ---------------------------------------------------------------------------

create policy messages_select on public.messages
  for select to authenticated
  using (public.is_member(conversation_id));

create policy messages_insert on public.messages
  for insert to authenticated
  with check (
    public.is_member(conversation_id)
    -- Interdit l'usurpation d'identité : on n'écrit que sous son propre nom.
    and sender_id = (select auth.uid())
    -- Le blocage est appliqué à l'écriture, côté base. Le filtrer seulement
    -- dans le client laisserait passer les messages par l'API et par les
    -- notifications push.
    and not public.is_blocked_in_conversation(conversation_id)
    -- Les messages système sont générés par le serveur (#41), jamais par un client.
    and kind <> 'system'
  );

create policy messages_update on public.messages
  for update to authenticated
  using (sender_id = (select auth.uid()))
  with check (sender_id = (select auth.uid()));

-- La fenêtre de modification est vérifiée ici plutôt que dans la policy : RLS
-- ne donne pas accès à l'ancienne ligne dans `with check`, et il faut pouvoir
-- distinguer une édition du corps d'une suppression logique — cette dernière
-- restant possible sans limite de temps.
create or replace function public.enforce_message_edit_window()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  edit_window constant interval := interval '15 minutes';
begin
  if new.body is distinct from old.body then
    if old.deleted_at is not null then
      raise exception 'un message supprimé ne se modifie plus'
        using errcode = 'check_violation';
    end if;

    if old.created_at < now() - edit_window then
      raise exception 'la fenêtre de modification est dépassée'
        using errcode = 'check_violation';
    end if;

    new.edited_at := now();
  end if;

  -- Ni le seq, ni la conversation, ni l'auteur, ni le client_id ne bougent :
  -- ce sont les invariants sur lesquels repose la synchronisation par curseur.
  if new.seq             is distinct from old.seq
     or new.conversation_id is distinct from old.conversation_id
     or new.client_id      is distinct from old.client_id
     or new.sender_id      is distinct from old.sender_id
     or new.created_at     is distinct from old.created_at then
    raise exception 'champ immuable modifié sur un message'
      using errcode = 'check_violation';
  end if;

  return new;
end;
$$;

create trigger messages_edit_guard
  before update on public.messages
  for each row execute function public.enforce_message_edit_window();

-- ---------------------------------------------------------------------------
-- attachments
-- ---------------------------------------------------------------------------

create policy attachments_select on public.attachments
  for select to authenticated
  using (public.can_read_message(message_id));

create policy attachments_insert on public.attachments
  for insert to authenticated
  with check (
    exists (
      select 1 from public.messages m
       where m.id = message_id
         and m.sender_id = (select auth.uid())
    )
  );

-- ---------------------------------------------------------------------------
-- reactions
-- ---------------------------------------------------------------------------

create policy reactions_select on public.reactions
  for select to authenticated
  using (public.can_read_message(message_id));

create policy reactions_insert on public.reactions
  for insert to authenticated
  with check (
    user_id = (select auth.uid())
    and public.can_read_message(message_id)
  );

create policy reactions_delete on public.reactions
  for delete to authenticated
  using (user_id = (select auth.uid()));

-- ---------------------------------------------------------------------------
-- receipts
-- ---------------------------------------------------------------------------

create policy receipts_select on public.receipts
  for select to authenticated
  using (public.can_read_message(message_id));

create policy receipts_insert on public.receipts
  for insert to authenticated
  with check (
    user_id = (select auth.uid())
    and public.can_read_message(message_id)
  );

create policy receipts_update on public.receipts
  for update to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

-- ---------------------------------------------------------------------------
-- contacts
-- ---------------------------------------------------------------------------
-- Strictement privées : le carnet d'adresses d'une personne ne regarde qu'elle.

create policy contacts_select on public.contacts
  for select to authenticated
  using (user_id = (select auth.uid()));

create policy contacts_insert on public.contacts
  for insert to authenticated
  with check (user_id = (select auth.uid()));

create policy contacts_delete on public.contacts
  for delete to authenticated
  using (user_id = (select auth.uid()));

-- ---------------------------------------------------------------------------
-- blocks
-- ---------------------------------------------------------------------------
-- Seul celui qui bloque voit ses blocages. La personne bloquée ne doit pas
-- pouvoir le détecter en lisant la table.

create policy blocks_select on public.blocks
  for select to authenticated
  using (blocker_id = (select auth.uid()));

create policy blocks_insert on public.blocks
  for insert to authenticated
  with check (blocker_id = (select auth.uid()));

create policy blocks_delete on public.blocks
  for delete to authenticated
  using (blocker_id = (select auth.uid()));

-- ---------------------------------------------------------------------------
-- reports
-- ---------------------------------------------------------------------------

create policy reports_insert on public.reports
  for insert to authenticated
  with check (reporter_id = (select auth.uid()));

create policy reports_select on public.reports
  for select to authenticated
  -- L'auteur suit son propre signalement. L'accès de l'équipe de modération à
  -- la file complète arrive avec le rôle dédié en #66.
  using (reporter_id = (select auth.uid()));

-- ---------------------------------------------------------------------------
-- Garde-fou : aucune table de `public` sans RLS
-- ---------------------------------------------------------------------------
-- Vérifié à la migration plutôt que laissé à la vigilance : une table ajoutée
-- plus tard sans RLS est une fuite de données, pas un oubli de style.

do $$
declare
  unprotected text;
begin
  select string_agg(c.relname, ', ' order by c.relname) into unprotected
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public'
     and c.relkind = 'r'
     and not c.relrowsecurity;

  if unprotected is not null then
    raise exception 'tables sans RLS dans public : %', unprotected;
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- Garde-fou : aucune fonction SECURITY DEFINER exécutable par le rôle anonyme
-- ---------------------------------------------------------------------------
-- Supabase pose un ALTER DEFAULT PRIVILEGES qui accorde EXECUTE à anon sur
-- toute nouvelle fonction du schéma public. Un `revoke ... from public` ne le
-- retire pas : le grant à anon est explicite, il faut le nommer.
--
-- Conséquence : toute fonction SECURITY DEFINER ajoutée plus tard sera
-- exposée au rôle anonyme par défaut. Ce contrôle échoue à la migration plutôt
-- que de laisser la brèche s'installer silencieusement.

do $$
declare
  exposed text;
begin
  select string_agg(p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')',
                    ', ' order by p.proname) into exposed
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and p.prosecdef
     and p.prokind = 'f'
     -- Les fonctions de trigger ne sont pas appelables directement.
     and p.prorettype <> 'trigger'::regtype
     and has_function_privilege('anon', p.oid, 'execute');

  if exposed is not null then
    raise exception
      'fonctions SECURITY DEFINER exécutables par anon : %. Ajouter « revoke all on function ... from public, anon; »',
      exposed;
  end if;
end;
$$;
