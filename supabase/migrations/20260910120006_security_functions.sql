-- #13 — fonctions SECURITY DEFINER d'appartenance et de blocage
--
-- Pourquoi ces fonctions existent :
--
-- Une policy RLS sur `messages` qui interroge `conversation_members`, elle-même
-- protégée par une policy qui interroge `messages`, produit une récursion que
-- Postgres rejette à l'exécution. La parade standard est d'encapsuler la
-- vérification dans une fonction SECURITY DEFINER, qui contourne RLS de façon
-- contrôlée et bornée.
--
-- Deux précautions non négociables sur chacune :
--
--   * `set search_path = ''` et qualification complète de tous les noms. Sans
--     cela, un utilisateur crée une table homonyme dans un schéma qu'il contrôle
--     et détourne la fonction — élévation de privilèges classique, signalée par
--     l'advisor de sécurité Supabase.
--
--   * `stable`, pour que Postgres mette le résultat en cache au sein d'une même
--     requête. Sur une page de cinquante messages, la différence est visible.

-- ---------------------------------------------------------------------------
-- is_member
-- ---------------------------------------------------------------------------

create or replace function public.is_member(conversation_id uuid)
returns boolean
language sql
security definer
stable
set search_path = ''
as $$
  select exists (
    select 1
      from public.conversation_members m
     where m.conversation_id = is_member.conversation_id
       and m.user_id = (select auth.uid())
  );
$$;

comment on function public.is_member(uuid) is
  'Appartenance à une conversation. SECURITY DEFINER pour éviter la récursion RLS.';

-- ---------------------------------------------------------------------------
-- is_admin
-- ---------------------------------------------------------------------------

create or replace function public.is_admin(conversation_id uuid)
returns boolean
language sql
security definer
stable
set search_path = ''
as $$
  select exists (
    select 1
      from public.conversation_members m
     where m.conversation_id = is_admin.conversation_id
       and m.user_id = (select auth.uid())
       and m.role in ('owner', 'admin')
  );
$$;

comment on function public.is_admin(uuid) is
  'Rôle owner ou admin sur une conversation.';

-- ---------------------------------------------------------------------------
-- is_blocked
-- ---------------------------------------------------------------------------

create or replace function public.is_blocked(other_user_id uuid)
returns boolean
language sql
security definer
stable
set search_path = ''
as $$
  -- Symétrique à dessein : que j'aie bloqué la personne ou qu'elle m'ait bloqué,
  -- l'échange s'arrête. Un blocage à sens unique laisserait passer les messages
  -- de celui qui bloque, ce qui n'est pas ce que l'utilisateur demande.
  select exists (
    select 1
      from public.blocks b
     where (b.blocker_id = (select auth.uid()) and b.blocked_id = is_blocked.other_user_id)
        or (b.blocker_id = is_blocked.other_user_id and b.blocked_id = (select auth.uid()))
  );
$$;

comment on function public.is_blocked(uuid) is
  'Blocage dans un sens ou dans l''autre. Symétrique.';

-- ---------------------------------------------------------------------------
-- is_blocked_in_conversation
-- ---------------------------------------------------------------------------

create or replace function public.is_blocked_in_conversation(conversation_id uuid)
returns boolean
language sql
security definer
stable
set search_path = ''
as $$
  -- Le blocage ne s'applique qu'aux conversations directes. Dans un groupe,
  -- bloquer quelqu'un masque ses messages côté client mais n'interdit pas au
  -- groupe de fonctionner : le filtrage y est une décision d'affichage, pas
  -- d'accès.
  select exists (
    select 1
      from public.conversations c
      join public.conversation_members m
        on m.conversation_id = c.id
     where c.id = is_blocked_in_conversation.conversation_id
       and c.type = 'dm'
       and m.user_id <> (select auth.uid())
       and public.is_blocked(m.user_id)
  );
$$;

comment on function public.is_blocked_in_conversation(uuid) is
  'Vrai si la conversation est un DM avec une personne bloquée, dans un sens ou dans l''autre.';

-- ---------------------------------------------------------------------------
-- can_read_message
-- ---------------------------------------------------------------------------

create or replace function public.can_read_message(message_id uuid)
returns boolean
language sql
security definer
stable
set search_path = ''
as $$
  -- Les pièces jointes, réactions et accusés s'alignent sur l'accès au message.
  -- Passer par une fonction plutôt qu'une sous-requête sur `messages` évite que
  -- la policy de `messages` soit réévaluée en cascade pour chaque ligne fille.
  select exists (
    select 1
      from public.messages m
     where m.id = can_read_message.message_id
       and public.is_member(m.conversation_id)
  );
$$;

comment on function public.can_read_message(uuid) is
  'Accès en lecture à un message. Sert de socle aux policies des tables filles.';

-- ---------------------------------------------------------------------------
-- Droits d'exécution
-- ---------------------------------------------------------------------------
-- Ces fonctions contournent RLS : elles ne doivent pas être appelables par le
-- rôle anonyme.
--
-- Révoquer sur PUBLIC ne suffit pas. Supabase pose un ALTER DEFAULT PRIVILEGES
-- qui accorde EXECUTE à anon, authenticated et service_role sur toute nouvelle
-- fonction du schéma public : anon reçoit donc un grant *explicite*, que le
-- revoke sur PUBLIC ne touche pas. Il faut le nommer.

revoke all on function public.is_member(uuid)                  from public, anon;
revoke all on function public.is_admin(uuid)                   from public, anon;
revoke all on function public.is_blocked(uuid)                 from public, anon;
revoke all on function public.is_blocked_in_conversation(uuid) from public, anon;
revoke all on function public.can_read_message(uuid)           from public, anon;

grant execute on function public.is_member(uuid)                  to authenticated;
grant execute on function public.is_admin(uuid)                   to authenticated;
grant execute on function public.is_blocked(uuid)                 to authenticated;
grant execute on function public.is_blocked_in_conversation(uuid) to authenticated;
grant execute on function public.can_read_message(uuid)            to authenticated;
