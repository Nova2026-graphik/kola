-- #10 — idempotence par client_id et attribution du seq
--
-- Les deux mécanismes qui rendent Kola utilisable sur un réseau intermittent.
-- Ce sont aussi ceux dont les défauts ne se voient qu'en production, après une
-- coupure au mauvais moment : ils sont donc testés ici, pas seulement relus.

begin;
create extension if not exists pgtap with schema extensions;
select plan(16);

-- Les messages système (#41) sont posés par trigger à chaque arrivée de membre,
-- chaque départ et chaque changement de titre. Les fixtures ci-dessous ne sont
-- pas des actions d'utilisateur : les laisser produire des annonces décalerait
-- tous les `seq` et fausserait ce que ces tests mesurent. On les fait donc
-- taire ici. Le comportement lui-même est vérifié dans 008_system_messages.sql.
select set_config('kola.suppress_system_messages', 'on', true);


-- ---------------------------------------------------------------------------
-- Fixtures
-- ---------------------------------------------------------------------------

insert into auth.users (id) values
  ('00000000-0000-0000-0000-00000000b001'),
  ('00000000-0000-0000-0000-00000000b002');

insert into public.conversations (id, type, title, owner_id)
values ('00000000-0000-0000-0000-0000000c0001', 'group', 'Tontine du quartier',
        '00000000-0000-0000-0000-00000000b001');

insert into public.conversation_members (conversation_id, user_id, role) values
  ('00000000-0000-0000-0000-0000000c0001', '00000000-0000-0000-0000-00000000b001', 'owner'),
  ('00000000-0000-0000-0000-0000000c0001', '00000000-0000-0000-0000-00000000b002', 'member');

-- ---------------------------------------------------------------------------
-- Attribution du seq
-- ---------------------------------------------------------------------------

insert into public.messages (client_id, conversation_id, sender_id, body)
values ('00000000-0000-0000-0000-00000000d001',
        '00000000-0000-0000-0000-0000000c0001',
        '00000000-0000-0000-0000-00000000b001', 'Bonjour');

select is(
  (select seq from public.messages where client_id = '00000000-0000-0000-0000-00000000d001'),
  1::bigint,
  'le premier message d''une conversation reçoit seq = 1'
);

insert into public.messages (client_id, conversation_id, sender_id, body)
values ('00000000-0000-0000-0000-00000000d002',
        '00000000-0000-0000-0000-0000000c0001',
        '00000000-0000-0000-0000-00000000b002', 'Salut');

select is(
  (select seq from public.messages where client_id = '00000000-0000-0000-0000-00000000d002'),
  2::bigint,
  'le seq s''incrémente d''un message à l''autre'
);

-- Vingt insertions supplémentaires : la suite doit rester strictement
-- croissante, sans trou et sans collision.
insert into public.messages (client_id, conversation_id, sender_id, body)
select extensions.gen_random_uuid(),
       '00000000-0000-0000-0000-0000000c0001',
       '00000000-0000-0000-0000-00000000b001',
       'message ' || i
  from generate_series(1, 20) i;

select is(
  (select count(*) from public.messages
    where conversation_id = '00000000-0000-0000-0000-0000000c0001')::int,
  22,
  '22 messages insérés'
);

select is(
  (select count(distinct seq) from public.messages
    where conversation_id = '00000000-0000-0000-0000-0000000c0001')::int,
  22,
  'aucune collision de seq'
);

select is(
  (select max(seq) from public.messages
    where conversation_id = '00000000-0000-0000-0000-0000000c0001'),
  22::bigint,
  'aucun trou dans la suite des seq'
);

select is(
  (select last_seq from public.conversations
    where id = '00000000-0000-0000-0000-0000000c0001'),
  22::bigint,
  'le compteur de la conversation suit le dernier seq attribué'
);

-- Le seq est propre à chaque conversation, pas global.
insert into public.conversations (id, type, title, owner_id)
values ('00000000-0000-0000-0000-0000000c0002', 'group', 'Réunion projet',
        '00000000-0000-0000-0000-00000000b001');
insert into public.conversation_members (conversation_id, user_id, role)
values ('00000000-0000-0000-0000-0000000c0002', '00000000-0000-0000-0000-00000000b001', 'owner');

insert into public.messages (client_id, conversation_id, sender_id, body)
values ('00000000-0000-0000-0000-00000000d100',
        '00000000-0000-0000-0000-0000000c0002',
        '00000000-0000-0000-0000-00000000b001', 'Premier ici aussi');

select is(
  (select seq from public.messages where client_id = '00000000-0000-0000-0000-00000000d100'),
  1::bigint,
  'chaque conversation a sa propre suite de seq'
);

-- ---------------------------------------------------------------------------
-- Idempotence
-- ---------------------------------------------------------------------------

-- Le scénario réel : l'outbox a envoyé, le réseau a coupé avant la réponse,
-- elle réémet. Le message ne doit pas être dupliqué.
select throws_ok(
  $$ insert into public.messages (client_id, conversation_id, sender_id, body)
     values ('00000000-0000-0000-0000-00000000d001',
             '00000000-0000-0000-0000-0000000c0001',
             '00000000-0000-0000-0000-00000000b001', 'Bonjour') $$,
  '23505',
  null,
  'réémettre le même client_id est rejeté au lieu de dupliquer'
);

-- Et la forme qu'utilisera réellement l'outbox : un upsert silencieux.
select lives_ok(
  $$ insert into public.messages (client_id, conversation_id, sender_id, body)
     values ('00000000-0000-0000-0000-00000000d001',
             '00000000-0000-0000-0000-0000000c0001',
             '00000000-0000-0000-0000-00000000b001', 'Bonjour')
     on conflict (client_id) do nothing $$,
  'la réémission avec on conflict do nothing n''échoue pas'
);

select is(
  (select count(*) from public.messages
    where client_id = '00000000-0000-0000-0000-00000000d001')::int,
  1,
  'la réémission n''a produit aucun doublon'
);

-- ---------------------------------------------------------------------------
-- Suppression logique
-- ---------------------------------------------------------------------------

-- Le chemin réel du repository (#28) met `deleted_at` ET vide le corps dans la
-- même opération. Marquer seulement `deleted_at` reproduirait une suppression
-- qui n'existe pas — c'est ce que faisait ce test, et c'est ce qui a laissé
-- passer le défaut corrigé par la migration 20260910120009.
update public.messages
   set deleted_at = now(), body = null
 where client_id = '00000000-0000-0000-0000-00000000d002';

select is(
  (select seq from public.messages where client_id = '00000000-0000-0000-0000-00000000d002'),
  2::bigint,
  'un message supprimé conserve son seq — sinon la reprise par curseur casserait'
);

select is(
  (select count(*) from public.messages
    where conversation_id = '00000000-0000-0000-0000-0000000c0001')::int,
  22,
  'la ligne du message supprimé est conservée'
);

-- ---------------------------------------------------------------------------
-- Contraintes de contenu
-- ---------------------------------------------------------------------------

select throws_ok(
  $$ insert into public.messages (client_id, conversation_id, sender_id, kind, body)
     values (extensions.gen_random_uuid(), '00000000-0000-0000-0000-0000000c0001',
             '00000000-0000-0000-0000-00000000b001', 'text', '   ') $$,
  '23514',
  null,
  'un message texte vide est rejeté'
);

-- Un message média sans pièce jointe est rejeté à la validation de la
-- transaction, la contrainte étant différée. `throws_ok` ne convient pas ici :
-- il ne peut pas exécuter de commande de transaction. On force la vérification
-- par SET CONSTRAINTS IMMEDIATE et on capture le SQLSTATE.
create or replace function pg_temp.media_without_attachment() returns text
language plpgsql as $fn$
begin
  insert into public.messages (client_id, conversation_id, sender_id, kind)
  values ('00000000-0000-0000-0000-00000000d900', '00000000-0000-0000-0000-0000000c0001',
          '00000000-0000-0000-0000-00000000b001', 'image');
  set constraints all immediate;
  return 'aucune erreur';
exception when others then
  return sqlstate;
end;
$fn$;

select is(
  pg_temp.media_without_attachment(),
  '23514',
  'un message média sans pièce jointe est rejeté à la validation'
);

-- ---------------------------------------------------------------------------
-- Réponse citée
-- ---------------------------------------------------------------------------

select throws_ok(
  $$ insert into public.messages (client_id, conversation_id, sender_id, body, reply_to_id)
     select extensions.gen_random_uuid(), '00000000-0000-0000-0000-0000000c0002',
            '00000000-0000-0000-0000-00000000b001', 'réponse',
            id from public.messages where client_id = '00000000-0000-0000-0000-00000000d001' $$,
  '23514',
  null,
  'citer un message d''une autre conversation est rejeté'
);

-- ---------------------------------------------------------------------------
-- Conversation directe : idempotence et limite à deux membres
-- ---------------------------------------------------------------------------

select throws_ok(
  $$ insert into public.conversations (id, type, dm_key, owner_id)
     values ('00000000-0000-0000-0000-0000000c0003', 'dm', 'x:y',
             '00000000-0000-0000-0000-00000000b001');
     insert into public.conversation_members (conversation_id, user_id) values
       ('00000000-0000-0000-0000-0000000c0003', '00000000-0000-0000-0000-00000000b001'),
       ('00000000-0000-0000-0000-0000000c0003', '00000000-0000-0000-0000-00000000b002');
     insert into auth.users (id) values ('00000000-0000-0000-0000-00000000b003');
     insert into public.conversation_members (conversation_id, user_id)
     values ('00000000-0000-0000-0000-0000000c0003', '00000000-0000-0000-0000-00000000b003') $$,
  '23514',
  null,
  'un troisième membre ne peut pas rejoindre une conversation directe'
);

select * from finish();
rollback;
