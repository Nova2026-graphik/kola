-- #37, #41 — création de groupe atomique et messages système
--
-- Deux propriétés dont l'échec est invisible au moment où il se produit :
--
--   * une création partielle laisse un groupe sans membres, donc invisible pour
--     tout le monde, y compris son créateur — et impossible à supprimer
--     puisque plus personne n'y a accès ;
--   * un message système écrit en français figé condamne l'internationalisation
--     (#63) rétroactivement : les messages déjà écrits resteront en français
--     chez tout le monde, pour toujours.

begin;
create extension if not exists pgtap with schema extensions;
select plan(23);

-- ---------------------------------------------------------------------------
-- Fixtures
-- ---------------------------------------------------------------------------

insert into auth.users (id) values
  ('00000000-0000-0000-0000-0000000a0001'),
  ('00000000-0000-0000-0000-0000000a0002'),
  ('00000000-0000-0000-0000-0000000a0003'),
  ('00000000-0000-0000-0000-0000000a0004'),
  ('00000000-0000-0000-0000-0000000a0005');

-- Pseudos préfixés « zt » : le seed en porte déjà des courants, et l'unicité
-- des pseudos (#22) est vérifiée sans distinction de casse.
update public.profiles set username = 'ztamina',   display_name = 'Amina'
 where id = '00000000-0000-0000-0000-0000000a0001';
update public.profiles set username = 'ztkodjo',   display_name = 'Kodjo'
 where id = '00000000-0000-0000-0000-0000000a0002';
update public.profiles set username = 'ztkossi',   display_name = 'Kossi'
 where id = '00000000-0000-0000-0000-0000000a0003';
update public.profiles set username = 'amztkossa', display_name = 'Makossa'
 where id = '00000000-0000-0000-0000-0000000a0004';
update public.profiles set username = 'amztkolo',  display_name = 'Kolo'
 where id = '00000000-0000-0000-0000-0000000a0005';

-- On se place dans la peau d'Amina : `create_group` lit `auth.uid()`.
set local role authenticated;
select set_config(
  'request.jwt.claims',
  '{"sub":"00000000-0000-0000-0000-0000000a0001","role":"authenticated"}',
  true
);

-- ---------------------------------------------------------------------------
-- Création
-- ---------------------------------------------------------------------------

select lives_ok(
  $$ select public.create_group(
       '00000000-0000-0000-0000-0000000c1001',
       'Tontine du quartier',
       array['00000000-0000-0000-0000-0000000a0002',
             '00000000-0000-0000-0000-0000000a0003']::uuid[]
     ) $$,
  'la création d''un groupe aboutit'
);

select is(
  (select count(*) from public.conversation_members m
     join public.conversations c on c.id = m.conversation_id
    where c.client_id = '00000000-0000-0000-0000-0000000c1001'),
  3::bigint,
  'le créateur et ses deux invités sont membres'
);

select is(
  (select m.role::text from public.conversation_members m
     join public.conversations c on c.id = m.conversation_id
    where c.client_id = '00000000-0000-0000-0000-0000000c1001'
      and m.user_id = '00000000-0000-0000-0000-0000000a0001'),
  'owner',
  'le créateur est propriétaire'
);

select is(
  (select count(distinct m.role) from public.conversation_members m
     join public.conversations c on c.id = m.conversation_id
    where c.client_id = '00000000-0000-0000-0000-0000000c1001'
      and m.user_id <> '00000000-0000-0000-0000-0000000a0001'
      and m.role = 'member'),
  1::bigint,
  'les invités sont de simples membres'
);

-- ---------------------------------------------------------------------------
-- Idempotence
-- ---------------------------------------------------------------------------
-- Sur un réseau qui coupe, une réponse perdue est indiscernable d'un échec.
-- Sans cette propriété, la réémission laisserait l'utilisateur avec deux
-- « Tontine du quartier » à moitié peuplées.

select is(
  (select public.create_group(
     '00000000-0000-0000-0000-0000000c1001',
     'Tontine du quartier',
     array['00000000-0000-0000-0000-0000000a0002']::uuid[]
   )),
  (select id from public.conversations
    where client_id = '00000000-0000-0000-0000-0000000c1001'),
  'la réémission retrouve le groupe au lieu d''en créer un second'
);

select is(
  (select count(*) from public.conversations
    where client_id = '00000000-0000-0000-0000-0000000c1001'),
  1::bigint,
  'un seul groupe existe'
);

-- ---------------------------------------------------------------------------
-- Validation
-- ---------------------------------------------------------------------------

select throws_ok(
  $$ select public.create_group('00000000-0000-0000-0000-0000000c1002', '   ',
       array['00000000-0000-0000-0000-0000000a0002']::uuid[]) $$,
  '23514',
  null,
  'un nom vide est refusé'
);

select throws_ok(
  $$ select public.create_group('00000000-0000-0000-0000-0000000c1003', repeat('x', 81),
       array['00000000-0000-0000-0000-0000000a0002']::uuid[]) $$,
  '23514',
  null,
  'un nom trop long est refusé'
);

-- Un groupe sans invité reste légitime : on crée d'abord, on invite ensuite.
select lives_ok(
  $$ select public.create_group('00000000-0000-0000-0000-0000000c1004', 'Notes à moi-même',
       array[]::uuid[]) $$,
  'un groupe sans invité est accepté'
);

-- ---------------------------------------------------------------------------
-- Le blocage n'est pas contournable par une invitation
-- ---------------------------------------------------------------------------

-- C'est Makossa qui bloque : la policy n'autorise à poser un blocage que sous
-- sa propre identité (#14). Le poser depuis le compte d'Amina échouerait — et
-- c'est bien ce qu'on veut.
select set_config(
  'request.jwt.claims',
  '{"sub":"00000000-0000-0000-0000-0000000a0004","role":"authenticated"}',
  true
);

insert into public.blocks (blocker_id, blocked_id)
values ('00000000-0000-0000-0000-0000000a0004', '00000000-0000-0000-0000-0000000a0001');

select set_config(
  'request.jwt.claims',
  '{"sub":"00000000-0000-0000-0000-0000000a0001","role":"authenticated"}',
  true
);

select is(
  (select public.create_group('00000000-0000-0000-0000-0000000c1005', 'Sans Makossa',
     array['00000000-0000-0000-0000-0000000a0002',
           '00000000-0000-0000-0000-0000000a0004']::uuid[]) is not null),
  true,
  'la création aboutit malgré un invité qui a bloqué le créateur'
);

select is_empty(
  $$ select m.user_id from public.conversation_members m
       join public.conversations c on c.id = m.conversation_id
      where c.client_id = '00000000-0000-0000-0000-0000000c1005'
        and m.user_id = '00000000-0000-0000-0000-0000000a0004' $$,
  'mais la personne qui a bloqué le créateur n''est pas ajoutée'
);

-- Un identifiant inventé est simplement ignoré : la liste arrive du réseau et
-- rien ne garantit qu'elle n'a pas été fabriquée à la main.
select is(
  (select count(*) from public.conversation_members m
     join public.conversations c on c.id = m.conversation_id
    where c.client_id = '00000000-0000-0000-0000-0000000c1005'),
  2::bigint,
  'seuls les profils existants sont ajoutés'
);

-- ---------------------------------------------------------------------------
-- Messages système
-- ---------------------------------------------------------------------------

select is(
  (select count(*) from public.messages m
     join public.conversations c on c.id = m.conversation_id
    where c.client_id = '00000000-0000-0000-0000-0000000c1001'
      and m.kind = 'system'),
  1::bigint,
  'la création produit UN message d''ouverture, pas une arrivée par membre'
);

select is(
  (select (m.body::jsonb) ->> 'type' from public.messages m
     join public.conversations c on c.id = m.conversation_id
    where c.client_id = '00000000-0000-0000-0000-0000000c1001'
      and m.kind = 'system'),
  'group_created',
  'le corps est structuré, pas une phrase'
);

-- La propriété qui protège #63 : rien de traduit n'est figé en base.
select is_empty(
  $$ select m.id from public.messages m
      where m.kind = 'system'
        and (m.body !~ '^\s*\{' or (m.body::jsonb) ->> 'type' is null) $$,
  'aucun message système n''est stocké autrement qu''en JSON typé'
);

-- --- arrivée --------------------------------------------------------------

insert into public.conversation_members (conversation_id, user_id)
select c.id, '00000000-0000-0000-0000-0000000a0004'
  from public.conversations c
 where c.client_id = '00000000-0000-0000-0000-0000000c1001';

select is(
  (select (m.body::jsonb) ->> 'target' from public.messages m
     join public.conversations c on c.id = m.conversation_id
    where c.client_id = '00000000-0000-0000-0000-0000000c1001'
      and m.kind = 'system'
    order by m.seq desc limit 1),
  '00000000-0000-0000-0000-0000000a0004',
  'ajouter un membre annonce son arrivée'
);

-- --- départ volontaire ------------------------------------------------------

select set_config(
  'request.jwt.claims',
  '{"sub":"00000000-0000-0000-0000-0000000a0004","role":"authenticated"}',
  true
);

delete from public.conversation_members m
 using public.conversations c
 where c.id = m.conversation_id
   and c.client_id = '00000000-0000-0000-0000-0000000c1001'
   and m.user_id = '00000000-0000-0000-0000-0000000a0004';

-- On revient dans la peau d'Amina pour lire : quelqu'un qui vient de quitter le
-- groupe n'en voit plus les messages, la policy de lecture s'y oppose. Lire
-- depuis son compte rendrait NULL — et masquerait ce qu'on veut vérifier.
select set_config(
  'request.jwt.claims',
  '{"sub":"00000000-0000-0000-0000-0000000a0001","role":"authenticated"}',
  true
);

select is(
  (select (m.body::jsonb) ->> 'type' from public.messages m
     join public.conversations c on c.id = m.conversation_id
    where c.client_id = '00000000-0000-0000-0000-0000000c1001'
      and m.kind = 'system'
    order by m.seq desc limit 1),
  'member_left',
  'partir de soi-même se raconte autrement qu''être retiré'
);

-- --- changement de titre ----------------------------------------------------

select set_config(
  'request.jwt.claims',
  '{"sub":"00000000-0000-0000-0000-0000000a0001","role":"authenticated"}',
  true
);

update public.conversations set title = 'Tontine de Bè'
 where client_id = '00000000-0000-0000-0000-0000000c1001';

select is(
  (select (m.body::jsonb) ->> 'title' from public.messages m
     join public.conversations c on c.id = m.conversation_id
    where c.client_id = '00000000-0000-0000-0000-0000000c1001'
      and m.kind = 'system'
    order by m.seq desc limit 1),
  'Tontine de Bè',
  'renommer le groupe l''annonce'
);

-- --- une conversation directe n'annonce rien --------------------------------

select set_config(
  'request.jwt.claims',
  '{"sub":"00000000-0000-0000-0000-0000000a0001","role":"authenticated"}',
  true
);

select public.get_or_create_dm('00000000-0000-0000-0000-0000000a0002');

select is_empty(
  $$ select m.id from public.messages m
       join public.conversations c on c.id = m.conversation_id
      where c.type = 'dm' and m.kind = 'system' $$,
  'une conversation directe ne produit aucun message système'
);

-- ---------------------------------------------------------------------------
-- Recherche de personnes
-- ---------------------------------------------------------------------------

select is(
  (select array_agg(username order by ordinality)
     from public.search_profiles('ztko') with ordinality),
  array['ztkodjo', 'ztkossi', 'amztkolo'],
  'le préfixe passe devant : qui tape « ztko » cherche ztkodjo, pas amztkolo'
);

-- Makossa a bloqué Amina plus haut. Ne pas le filtrer ici laisserait le blocage
-- se contourner d'un pas : on ne peut pas l'inviter, mais on le voit encore.
select is_empty(
  $$ select username from public.search_profiles('amztkossa') $$,
  'on ne propose pas quelqu''un qui vous a bloqué'
);

-- La règle qui compte : une recherche ouverte qui rendrait les numéros serait
-- un annuaire inversé offert à qui sait taper trois lettres.
select is_empty(
  $$ select column_name from information_schema.columns
      where table_schema = 'public'
        and table_name = 'search_profiles'
        and column_name in ('phone_e164', 'phone') $$,
  'la recherche ne rend jamais le numéro de téléphone'
);

select is_empty(
  $$ select username from public.search_profiles('ztamina') $$,
  'on ne se trouve pas soi-même'
);

select * from finish();
rollback;
