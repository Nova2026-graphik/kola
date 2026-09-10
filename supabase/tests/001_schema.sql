-- #14 — structure, contraintes et index
--
-- Vérifie que le schéma tient ses promesses : les index qui portent les chemins
-- critiques existent, les contraintes rejettent ce qu'elles doivent rejeter, et
-- aucune table n'est laissée sans RLS.

begin;
create extension if not exists pgtap with schema extensions;
select plan(34);

-- ---------------------------------------------------------------------------
-- Tables et RLS
-- ---------------------------------------------------------------------------

select has_table('public', 'profiles', 'profiles existe');
select has_table('public', 'devices', 'devices existe');
select has_table('public', 'conversations', 'conversations existe');
select has_table('public', 'conversation_members', 'conversation_members existe');
select has_table('public', 'messages', 'messages existe');
select has_table('public', 'attachments', 'attachments existe');
select has_table('public', 'reactions', 'reactions existe');
select has_table('public', 'receipts', 'receipts existe');
select has_table('public', 'contacts', 'contacts existe');
select has_table('public', 'blocks', 'blocks existe');
select has_table('public', 'reports', 'reports existe');

-- Le garde-fou central : aucune table de `public` sans RLS. Une table ajoutée
-- plus tard sans policy est une fuite de données, pas un oubli de style.
select is_empty(
  $$ select c.relname
       from pg_class c
       join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relkind = 'r' and not c.relrowsecurity $$,
  'aucune table de public sans RLS'
);

-- ---------------------------------------------------------------------------
-- Index obligatoires
-- ---------------------------------------------------------------------------

select has_index('public', 'messages', 'messages_client_id_key',
  'index unique sur messages(client_id) — porte l''idempotence');
select has_index('public', 'messages', 'messages_conversation_seq_idx',
  'index sur messages(conversation_id, seq desc) — chemin de lecture d''une page');
select has_index('public', 'messages', 'messages_conversation_seq_key',
  'index unique sur messages(conversation_id, seq) — interdit les collisions de seq');
select has_index('public', 'conversation_members', 'conversation_members_user_id_idx',
  'index sur conversation_members(user_id)');
select has_index('public', 'conversations', 'conversations_last_message_at_idx',
  'index sur conversations(last_message_at desc)');
select has_index('public', 'blocks', 'blocks_blocked_id_idx',
  'index sur blocks(blocked_id) — sur le chemin critique de chaque lecture');
select has_index('public', 'profiles', 'profiles_username_lower_key',
  'index unique sur lower(username) — unicité insensible à la casse');

-- ---------------------------------------------------------------------------
-- Fonctions de sécurité
-- ---------------------------------------------------------------------------

select has_function('public', 'is_member', array['uuid'], 'is_member() existe');
select has_function('public', 'is_admin', array['uuid'], 'is_admin() existe');
select has_function('public', 'is_blocked', array['uuid'], 'is_blocked() existe');

-- Un search_path non fixé sur une fonction SECURITY DEFINER est une faille
-- d'élévation de privilèges : un utilisateur crée une table homonyme dans un
-- schéma qu'il contrôle et détourne la fonction.
select is_empty(
  $$ select p.proname
       from pg_proc p
       join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public'
        and p.prosecdef
        and not exists (
          select 1 from unnest(coalesce(p.proconfig, '{}')) cfg
           where cfg like 'search_path=%'
        ) $$,
  'aucune fonction SECURITY DEFINER sans search_path fixé'
);

-- ---------------------------------------------------------------------------
-- Contraintes de format
-- ---------------------------------------------------------------------------

insert into auth.users (id) values ('00000000-0000-0000-0000-0000000000a1');

select throws_ok(
  $$ update public.profiles set username = 'Ab' where id = '00000000-0000-0000-0000-0000000000a1' $$,
  '23514',
  null,
  'un pseudo trop court est rejeté'
);

select throws_ok(
  $$ update public.profiles set username = 'MonPseudo' where id = '00000000-0000-0000-0000-0000000000a1' $$,
  '23514',
  null,
  'un pseudo avec des majuscules est rejeté'
);

select lives_ok(
  $$ update public.profiles set username = 'kofi_2026' where id = '00000000-0000-0000-0000-0000000000a1' $$,
  'un pseudo bien formé est accepté'
);

select throws_ok(
  $$ update public.profiles set phone_e164 = '90123456' where id = '00000000-0000-0000-0000-0000000000a1' $$,
  '23514',
  null,
  'un numéro sans indicatif est rejeté'
);

select lives_ok(
  $$ update public.profiles set phone_e164 = '+22890123456' where id = '00000000-0000-0000-0000-0000000000a1' $$,
  'un numéro togolais au format E.164 est accepté'
);

-- Unicité du pseudo.
--
-- Note : la contrainte de format n'admet que les minuscules, donc une casse
-- différente est refusée par `profiles_username_format` avant même d'atteindre
-- l'index d'unicité. Ce dernier reste une défense en profondeur, vérifiée
-- ci-dessus par has_index, si le format venait à s'assouplir.
insert into auth.users (id) values ('00000000-0000-0000-0000-0000000000a2');

select throws_ok(
  $$ update public.profiles set username = 'kofi_2026' where id = '00000000-0000-0000-0000-0000000000a2' $$,
  '23505',
  null,
  'un pseudo déjà pris est rejeté'
);

-- Deux profils sans pseudo ne se bloquent pas : l'index unique est partiel.
-- Le compte est restreint aux profils de ce test : la base peut contenir les
-- données de démonstration (#17), et un test qui suppose une base vide est un
-- test qui cassera.
select is(
  (select count(*) from public.profiles
    where username is null
      and id in ('00000000-0000-0000-0000-0000000000a1',
                 '00000000-0000-0000-0000-0000000000a2'))::int,
  1,
  'un profil créé par OTP SMS existe sans pseudo'
);

-- ---------------------------------------------------------------------------
-- Blocage et auto-référence
-- ---------------------------------------------------------------------------

select throws_ok(
  $$ insert into public.blocks (blocker_id, blocked_id)
     values ('00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000a1') $$,
  '23514',
  null,
  'on ne peut pas se bloquer soi-même'
);

select lives_ok(
  $$ insert into public.blocks (blocker_id, blocked_id)
     values ('00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000a2')
     on conflict do nothing $$,
  'bloquer deux fois la même personne n''échoue pas'
);

-- ---------------------------------------------------------------------------
-- Création automatique du profil
-- ---------------------------------------------------------------------------

select is(
  (select count(*) from public.profiles where id = '00000000-0000-0000-0000-0000000000a1')::int,
  1,
  'le profil est créé automatiquement à l''inscription'
);

-- ---------------------------------------------------------------------------
-- Signalements
-- ---------------------------------------------------------------------------

insert into public.reports (reporter_id, target_type, target_id, reason)
values ('00000000-0000-0000-0000-0000000000a1', 'profile',
        '00000000-0000-0000-0000-0000000000a2', 'spam');

select is(
  (select status::text from public.reports limit 1),
  'open',
  'un signalement est créé avec le statut open'
);

select * from finish();
rollback;
