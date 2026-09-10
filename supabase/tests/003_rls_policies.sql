-- #14 — policies RLS, cas passant et cas refusé
--
-- Une policy RLS ne se relit pas : elle se teste. Le raisonnement humain sur des
-- conditions imbriquées avec auth.uid() et des fonctions SECURITY DEFINER est
-- peu fiable, et l'erreur se paie en fuite de données, pas en bug d'affichage.
--
-- Chaque test bascule sur le rôle `authenticated` avec un sub différent, ce qui
-- reproduit exactement ce que fait PostgREST pour une requête du client mobile.

begin;
create extension if not exists pgtap with schema extensions;
select plan(26);

-- ---------------------------------------------------------------------------
-- Fixtures, créées en tant que postgres (RLS contournée)
-- ---------------------------------------------------------------------------
--   alice  : membre et propriétaire du groupe
--   bob    : membre simple du groupe
--   carla  : étrangère au groupe
--   dan    : a bloqué alice

insert into auth.users (id) values
  ('00000000-0000-0000-0000-00000000a1a1'), -- alice
  ('00000000-0000-0000-0000-00000000b2b2'), -- bob
  ('00000000-0000-0000-0000-00000000c3c3'), -- carla
  ('00000000-0000-0000-0000-00000000d4d4'); -- dan

update public.profiles set username = 'test_alice_003', display_name = 'Alice'
 where id = '00000000-0000-0000-0000-00000000a1a1';
update public.profiles set username = 'test_bob_003', display_name = 'Bob'
 where id = '00000000-0000-0000-0000-00000000b2b2';
update public.profiles set username = 'test_carla_003', display_name = 'Carla'
 where id = '00000000-0000-0000-0000-00000000c3c3';
update public.profiles set username = 'test_dan_003', display_name = 'Dan'
 where id = '00000000-0000-0000-0000-00000000d4d4';

-- Dan bloque Alice.
insert into public.blocks (blocker_id, blocked_id)
values ('00000000-0000-0000-0000-00000000d4d4', '00000000-0000-0000-0000-00000000a1a1');

insert into public.conversations (id, type, title, owner_id)
values ('00000000-0000-0000-0000-0000000a0001', 'group', 'Équipe Kola',
        '00000000-0000-0000-0000-00000000a1a1');

insert into public.conversation_members (conversation_id, user_id, role) values
  ('00000000-0000-0000-0000-0000000a0001', '00000000-0000-0000-0000-00000000a1a1', 'owner'),
  ('00000000-0000-0000-0000-0000000a0001', '00000000-0000-0000-0000-00000000b2b2', 'member');

insert into public.messages (client_id, conversation_id, sender_id, body) values
  ('00000000-0000-0000-0000-00000000e001', '00000000-0000-0000-0000-0000000a0001',
   '00000000-0000-0000-0000-00000000a1a1', 'Message d''Alice'),
  ('00000000-0000-0000-0000-00000000e002', '00000000-0000-0000-0000-0000000a0001',
   '00000000-0000-0000-0000-00000000b2b2', 'Message de Bob');

-- Conversation directe entre Alice et Dan, qui se sont bloqués.
insert into public.conversations (id, type, dm_key, owner_id)
values ('00000000-0000-0000-0000-0000000a0002', 'dm',
        least('00000000-0000-0000-0000-00000000a1a1', '00000000-0000-0000-0000-00000000d4d4')
        || ':' ||
        greatest('00000000-0000-0000-0000-00000000a1a1', '00000000-0000-0000-0000-00000000d4d4'),
        '00000000-0000-0000-0000-00000000a1a1');

insert into public.conversation_members (conversation_id, user_id) values
  ('00000000-0000-0000-0000-0000000a0002', '00000000-0000-0000-0000-00000000a1a1'),
  ('00000000-0000-0000-0000-0000000a0002', '00000000-0000-0000-0000-00000000d4d4');

-- ===========================================================================
-- CARLA — étrangère à la conversation
-- ===========================================================================

set local role authenticated;
set local request.jwt.claims to '{"sub":"00000000-0000-0000-0000-00000000c3c3","role":"authenticated"}';

select is(
  (select count(*) from public.messages
    where conversation_id = '00000000-0000-0000-0000-0000000a0001')::int,
  0,
  'un non-membre ne lit aucun message de la conversation'
);

select is(
  (select count(*) from public.conversations
    where id = '00000000-0000-0000-0000-0000000a0001')::int,
  0,
  'un non-membre ne voit pas la conversation elle-même'
);

select is(
  (select count(*) from public.conversation_members
    where conversation_id = '00000000-0000-0000-0000-0000000a0001')::int,
  0,
  'un non-membre ne voit pas la liste des membres'
);

select is(
  (select count(*) from public.attachments)::int,
  0,
  'un non-membre ne voit aucune pièce jointe'
);

-- La tentative la plus évidente : écrire dans une conversation où l'on n'est pas.
select throws_ok(
  $$ insert into public.messages (client_id, conversation_id, sender_id, body)
     values (extensions.gen_random_uuid(), '00000000-0000-0000-0000-0000000a0001',
             '00000000-0000-0000-0000-00000000c3c3', 'intrusion') $$,
  '42501',
  null,
  'un non-membre ne peut pas écrire dans la conversation'
);

-- Les profils restent lisibles : c'est ce qui permet d'afficher un nom.
select is(
  (select display_name from public.profiles
    where id = '00000000-0000-0000-0000-00000000a1a1'),
  'Alice',
  'un profil reste lisible par tout utilisateur authentifié'
);

select is(
  (select count(*) from public.blocks)::int,
  0,
  'les blocages des autres ne sont pas visibles'
);

-- ===========================================================================
-- BOB — membre simple
-- ===========================================================================

set local request.jwt.claims to '{"sub":"00000000-0000-0000-0000-00000000b2b2","role":"authenticated"}';

select is(
  (select count(*) from public.messages
    where conversation_id = '00000000-0000-0000-0000-0000000a0001')::int,
  2,
  'un membre lit les messages de sa conversation'
);

select lives_ok(
  $$ insert into public.messages (client_id, conversation_id, sender_id, body)
     values (extensions.gen_random_uuid(), '00000000-0000-0000-0000-0000000a0001',
             '00000000-0000-0000-0000-00000000b2b2', 'Bonjour tout le monde') $$,
  'un membre peut écrire dans sa conversation'
);

-- L'usurpation d'identité : écrire un message signé par quelqu'un d'autre.
select throws_ok(
  $$ insert into public.messages (client_id, conversation_id, sender_id, body)
     values (extensions.gen_random_uuid(), '00000000-0000-0000-0000-0000000a0001',
             '00000000-0000-0000-0000-00000000a1a1', 'faux message d''Alice') $$,
  '42501',
  null,
  'un membre ne peut pas écrire sous l''identité d''un autre'
);

-- Les messages système sont générés par le serveur, jamais par un client.
select throws_ok(
  $$ insert into public.messages (client_id, conversation_id, sender_id, kind, body)
     values (extensions.gen_random_uuid(), '00000000-0000-0000-0000-0000000a0001',
             '00000000-0000-0000-0000-00000000b2b2', 'system',
             '{"type":"member_added"}') $$,
  '42501',
  null,
  'un client ne peut pas fabriquer un message système'
);

-- Un membre simple ne gouverne pas le groupe.
select is(
  (select count(*) from public.conversations
    where id = '00000000-0000-0000-0000-0000000a0001'),
  1::bigint,
  'un membre simple voit la conversation'
);

update public.conversations set title = 'Titre détourné'
 where id = '00000000-0000-0000-0000-0000000a0001';

select is(
  (select title from public.conversations
    where id = '00000000-0000-0000-0000-0000000a0001'),
  'Équipe Kola',
  'un membre simple ne peut pas renommer le groupe'
);

-- Ni s'auto-promouvoir : la policy laisse passer l'UPDATE de sa propre ligne,
-- c'est le trigger de garde qui refuse le changement de rôle.
select throws_ok(
  $$ update public.conversation_members set role = 'admin'
      where conversation_id = '00000000-0000-0000-0000-0000000a0001'
        and user_id = '00000000-0000-0000-0000-00000000b2b2' $$,
  '42501',
  null,
  'un membre simple ne peut pas se promouvoir administrateur'
);

-- En revanche il gère bien ses propres réglages.
select lives_ok(
  $$ update public.conversation_members set muted_until = now() + interval '1 day'
      where conversation_id = '00000000-0000-0000-0000-0000000a0001'
        and user_id = '00000000-0000-0000-0000-00000000b2b2' $$,
  'un membre peut mettre sa propre conversation en sourdine'
);

-- Il ne modifie pas les messages des autres.
update public.messages set body = 'contenu falsifié'
 where client_id = '00000000-0000-0000-0000-00000000e001';

select is(
  (select body from public.messages where client_id = '00000000-0000-0000-0000-00000000e001'),
  'Message d''Alice',
  'un membre ne peut pas modifier le message d''un autre'
);

-- Et ne supprime physiquement rien : aucune policy for delete sur messages.
delete from public.messages where client_id = '00000000-0000-0000-0000-00000000e001';

select is(
  (select count(*) from public.messages
    where client_id = '00000000-0000-0000-0000-00000000e001')::int,
  1,
  'aucun DELETE physique n''est possible sur un message'
);

-- ===========================================================================
-- ALICE — propriétaire, et bloquée par Dan
-- ===========================================================================

set local request.jwt.claims to '{"sub":"00000000-0000-0000-0000-00000000a1a1","role":"authenticated"}';

select lives_ok(
  $$ update public.conversations set title = 'Équipe Kola — V1'
      where id = '00000000-0000-0000-0000-0000000a0001' $$,
  'le propriétaire peut renommer le groupe'
);

select lives_ok(
  $$ update public.conversation_members set role = 'admin'
      where conversation_id = '00000000-0000-0000-0000-0000000a0001'
        and user_id = '00000000-0000-0000-0000-00000000b2b2' $$,
  'le propriétaire peut promouvoir un membre'
);

-- Le blocage est appliqué à l'écriture, côté base. Le filtrer seulement dans le
-- client laisserait passer les messages par l'API et par les notifications.
select throws_ok(
  $$ insert into public.messages (client_id, conversation_id, sender_id, body)
     values (extensions.gen_random_uuid(), '00000000-0000-0000-0000-0000000a0002',
             '00000000-0000-0000-0000-00000000a1a1', 'tu me lis ?') $$,
  '42501',
  null,
  'une personne bloquée ne peut pas écrire dans la conversation directe'
);

-- Le profil de celui qui a bloqué devient invisible, dans les deux sens.
select is(
  (select count(*) from public.profiles
    where id = '00000000-0000-0000-0000-00000000d4d4')::int,
  0,
  'le profil de la personne qui a bloqué n''est plus lisible'
);

-- Elle modifie ses propres messages.
select lives_ok(
  $$ update public.messages set body = 'Message d''Alice, corrigé'
      where client_id = '00000000-0000-0000-0000-00000000e001' $$,
  'l''auteur peut modifier son propre message'
);

select isnt(
  (select edited_at from public.messages where client_id = '00000000-0000-0000-0000-00000000e001'),
  null,
  'la modification renseigne edited_at automatiquement'
);

-- Les invariants de synchronisation ne se touchent pas, même par l'auteur.
select throws_ok(
  $$ update public.messages set seq = 999
      where client_id = '00000000-0000-0000-0000-00000000e001' $$,
  '23514',
  null,
  'le seq d''un message est immuable, même pour son auteur'
);

-- ===========================================================================
-- Rôle anonyme
-- ===========================================================================

reset role;
set local role anon;
set local request.jwt.claims to '{"role":"anon"}';

select is(
  (select count(*) from public.profiles)::int,
  0,
  'une requête anonyme ne retourne aucun profil'
);

select throws_ok(
  $$ select public.is_member('00000000-0000-0000-0000-0000000a0001') $$,
  '42501',
  null,
  'le rôle anonyme ne peut pas exécuter les fonctions de sécurité'
);

reset role;
select * from finish();
rollback;
