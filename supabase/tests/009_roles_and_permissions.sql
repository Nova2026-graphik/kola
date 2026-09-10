-- #39 — matrice des rôles, appliquée côté serveur
--
-- L'interface reflète les permissions pour ne pas proposer d'action vouée à
-- l'échec, mais elle ne constitue jamais la sécurité. Ce fichier vérifie la
-- seule chose qui compte : ce qui se passe quand la demande arrive quand même,
-- par appel direct à l'API.
--
-- La matrice est couverte combinaison par combinaison. C'est verbeux, et c'est
-- volontaire : une case oubliée dans un test paramétré ne se voit pas, une case
-- oubliée dans une liste explicite se voit.

begin;
create extension if not exists pgtap with schema extensions;
select plan(27);

-- ---------------------------------------------------------------------------
-- Fixtures : un groupe, un propriétaire, un administrateur, un membre
-- ---------------------------------------------------------------------------

insert into auth.users (id) values
  ('00000000-0000-0000-0000-00000000c001'),
  ('00000000-0000-0000-0000-00000000c002'),
  ('00000000-0000-0000-0000-00000000c003'),
  ('00000000-0000-0000-0000-00000000c004');

select set_config('kola.suppress_system_messages', 'on', true);

insert into public.conversations (id, type, title, owner_id)
values ('00000000-0000-0000-0000-0000000cc001', 'group', 'Tontine',
        '00000000-0000-0000-0000-00000000c001');

insert into public.conversation_members (conversation_id, user_id, role) values
  ('00000000-0000-0000-0000-0000000cc001', '00000000-0000-0000-0000-00000000c001', 'owner'),
  ('00000000-0000-0000-0000-0000000cc001', '00000000-0000-0000-0000-00000000c002', 'admin'),
  ('00000000-0000-0000-0000-0000000cc001', '00000000-0000-0000-0000-00000000c003', 'member');

select set_config('kola.suppress_system_messages', 'off', true);

set local role authenticated;

create or replace function pg_temp.act_as(who uuid) returns void
language sql as $$
  select set_config('request.jwt.claims',
    json_build_object('sub', who, 'role', 'authenticated')::text, true);
  select null::void;
$$;

-- ---------------------------------------------------------------------------
-- has_permission reflète la matrice
-- ---------------------------------------------------------------------------

select pg_temp.act_as('00000000-0000-0000-0000-00000000c003');

select is(
  (select array_agg(p.permission order by p.permission)
     from public.role_permissions p where p.role = 'member'),
  array['leave', 'send_message'],
  'un membre simple n''a que deux permissions'
);

select ok(
  public.has_permission('00000000-0000-0000-0000-0000000cc001', 'send_message'),
  'un membre peut écrire'
);
select ok(
  not public.has_permission('00000000-0000-0000-0000-0000000cc001', 'add_member'),
  'un membre ne peut pas ajouter'
);
select ok(
  not public.has_permission('00000000-0000-0000-0000-0000000cc001', 'remove_member'),
  'un membre ne peut pas retirer'
);
select ok(
  not public.has_permission('00000000-0000-0000-0000-0000000cc001', 'edit_group'),
  'un membre ne peut pas modifier le groupe'
);
select ok(
  not public.has_permission('00000000-0000-0000-0000-0000000cc001', 'change_role'),
  'un membre ne peut pas changer un rôle'
);

select pg_temp.act_as('00000000-0000-0000-0000-00000000c002');

select ok(
  public.has_permission('00000000-0000-0000-0000-0000000cc001', 'add_member')
  and public.has_permission('00000000-0000-0000-0000-0000000cc001', 'remove_member')
  and public.has_permission('00000000-0000-0000-0000-0000000cc001', 'edit_group'),
  'un administrateur ajoute, retire et modifie'
);

-- Le point de #39 : promouvoir reste au propriétaire. Un administrateur qui
-- peut en nommer d'autres peut aussi les rétrograder, et le propriétaire n'a
-- alors aucun recours.
select ok(
  not public.has_permission('00000000-0000-0000-0000-0000000cc001', 'change_role'),
  'un administrateur ne change pas les rôles'
);
select ok(
  not public.has_permission('00000000-0000-0000-0000-0000000cc001', 'transfer_ownership'),
  'un administrateur ne transfère pas la propriété'
);

select pg_temp.act_as('00000000-0000-0000-0000-00000000c001');

select ok(
  public.has_permission('00000000-0000-0000-0000-0000000cc001', 'change_role')
  and public.has_permission('00000000-0000-0000-0000-0000000cc001', 'transfer_ownership')
  and public.has_permission('00000000-0000-0000-0000-0000000cc001', 'delete_group')
  and public.has_permission('00000000-0000-0000-0000-0000000cc001', 'set_restricted'),
  'le propriétaire a les permissions réservées'
);

-- Et l'inverse, qui est la vraie règle de #42 : le propriétaire ne part pas.
select ok(
  not public.has_permission('00000000-0000-0000-0000-0000000cc001', 'leave'),
  'le propriétaire n''a pas la permission de quitter'
);

-- ---------------------------------------------------------------------------
-- Ce que la matrice change VRAIMENT : les policies
-- ---------------------------------------------------------------------------

select pg_temp.act_as('00000000-0000-0000-0000-00000000c003');

select throws_ok(
  $$ insert into public.conversation_members (conversation_id, user_id, role)
     values ('00000000-0000-0000-0000-0000000cc001',
             '00000000-0000-0000-0000-00000000c004', 'member') $$,
  '42501',
  null,
  'un membre simple ne peut pas ajouter quelqu''un, même par appel direct'
);

-- Une clause `using` de policy FILTRE, elle ne lève pas : l'UPDATE ne touche
-- aucune ligne et rend « UPDATE 0 ». Seule une clause `with check` produit un
-- 42501. La distinction compte pour le client, qui ne peut donc pas se fier à
-- l'absence d'erreur pour conclure qu'une modification a eu lieu.
update public.conversations set title = 'Détourné'
 where id = '00000000-0000-0000-0000-0000000cc001';

select is(
  (select title from public.conversations
    where id = '00000000-0000-0000-0000-0000000cc001'),
  'Tontine',
  'un membre simple ne peut pas renommer le groupe : la ligne n''est pas touchée'
);

select throws_ok(
  $$ update public.conversation_members set role = 'admin'
      where conversation_id = '00000000-0000-0000-0000-0000000cc001'
        and user_id = '00000000-0000-0000-0000-00000000c003' $$,
  '42501',
  null,
  'un membre simple ne se promeut pas'
);

select pg_temp.act_as('00000000-0000-0000-0000-00000000c002');

select throws_ok(
  $$ update public.conversation_members set role = 'admin'
      where conversation_id = '00000000-0000-0000-0000-0000000cc001'
        and user_id = '00000000-0000-0000-0000-00000000c003' $$,
  '42501',
  null,
  'un administrateur non plus'
);

select lives_ok(
  $$ update public.conversations set title = 'Tontine de Bè'
      where id = '00000000-0000-0000-0000-0000000cc001' $$,
  'un administrateur renomme le groupe'
);

-- ---------------------------------------------------------------------------
-- Mode restreint
-- ---------------------------------------------------------------------------

select pg_temp.act_as('00000000-0000-0000-0000-00000000c002');

select throws_ok(
  $$ update public.conversations set restricted = true
      where id = '00000000-0000-0000-0000-0000000cc001' $$,
  '42501',
  null,
  'un administrateur ne restreint pas l''écriture'
);

select pg_temp.act_as('00000000-0000-0000-0000-00000000c001');

select lives_ok(
  $$ update public.conversations set restricted = true
      where id = '00000000-0000-0000-0000-0000000cc001' $$,
  'le propriétaire restreint l''écriture'
);

select pg_temp.act_as('00000000-0000-0000-0000-00000000c003');

-- Le critère d'acceptation de #39, mot pour mot : « y compris par appel direct
-- à l'API ». C'est pourquoi la règle est dans la policy et non dans l'écran.
select throws_ok(
  $$ insert into public.messages (client_id, conversation_id, sender_id, body)
     values (extensions.gen_random_uuid(), '00000000-0000-0000-0000-0000000cc001',
             '00000000-0000-0000-0000-00000000c003', 'je passe quand même') $$,
  '42501',
  null,
  'en mode restreint, un membre simple ne peut pas écrire'
);

select pg_temp.act_as('00000000-0000-0000-0000-00000000c002');

select lives_ok(
  $$ insert into public.messages (client_id, conversation_id, sender_id, body)
     values (extensions.gen_random_uuid(), '00000000-0000-0000-0000-0000000cc001',
             '00000000-0000-0000-0000-00000000c002', 'moi si') $$,
  'un administrateur écrit toujours'
);

select pg_temp.act_as('00000000-0000-0000-0000-00000000c001');
update public.conversations set restricted = false
 where id = '00000000-0000-0000-0000-0000000cc001';

-- ---------------------------------------------------------------------------
-- Le groupe ne se retrouve jamais sans propriétaire
-- ---------------------------------------------------------------------------

select throws_ok(
  $$ delete from public.conversation_members
      where conversation_id = '00000000-0000-0000-0000-0000000cc001'
        and user_id = '00000000-0000-0000-0000-00000000c001' $$,
  '23514',
  null,
  'le propriétaire ne peut pas quitter le groupe'
);

select pg_temp.act_as('00000000-0000-0000-0000-00000000c002');

select throws_ok(
  $$ delete from public.conversation_members
      where conversation_id = '00000000-0000-0000-0000-0000000cc001'
        and user_id = '00000000-0000-0000-0000-00000000c001' $$,
  '23514',
  null,
  'un administrateur ne peut pas retirer le propriétaire non plus'
);

select lives_ok(
  $$ delete from public.conversation_members
      where conversation_id = '00000000-0000-0000-0000-0000000cc001'
        and user_id = '00000000-0000-0000-0000-00000000c003' $$,
  'un administrateur retire un membre simple'
);

-- ---------------------------------------------------------------------------
-- Transfert de propriété
-- ---------------------------------------------------------------------------

select throws_ok(
  $$ select public.transfer_ownership('00000000-0000-0000-0000-0000000cc001',
       '00000000-0000-0000-0000-00000000c002') $$,
  '42501',
  null,
  'un administrateur ne se transfère pas la propriété'
);

select pg_temp.act_as('00000000-0000-0000-0000-00000000c001');

select lives_ok(
  $$ select public.transfer_ownership('00000000-0000-0000-0000-0000000cc001',
       '00000000-0000-0000-0000-00000000c002') $$,
  'le propriétaire transfère la propriété'
);

select is(
  (select array_agg(m.role::text order by m.user_id)
     from public.conversation_members m
    where m.conversation_id = '00000000-0000-0000-0000-0000000cc001'),
  array['admin', 'owner'],
  'l''ancien propriétaire devient administrateur, le nouveau propriétaire'
);

select is(
  (select count(*) from public.conversation_members m
    where m.conversation_id = '00000000-0000-0000-0000-0000000cc001'
      and m.role = 'owner'),
  1::bigint,
  'il y a toujours exactement un propriétaire'
);

select * from finish();
rollback;
