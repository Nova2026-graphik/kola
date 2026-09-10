-- #53 — suite de changements, curseur de la synchronisation delta
--
-- `change_seq` est ce qui permet à un client resté trois jours hors ligne de ne
-- récupérer que ce qui lui manque. Ses défauts sont invisibles jusqu'au jour où
-- un message manque sur un appareil, sans trace exploitable : ils sont donc
-- vérifiés ici plutôt que relus.

begin;
create extension if not exists pgtap with schema extensions;
select plan(15);

-- ---------------------------------------------------------------------------
-- Fixtures
-- ---------------------------------------------------------------------------

insert into auth.users (id) values
  ('00000000-0000-0000-0000-00000000e001'),
  ('00000000-0000-0000-0000-00000000e002');

insert into public.conversations (id, type, title, owner_id)
values ('00000000-0000-0000-0000-0000000e0001', 'group', 'Marché de Hédzranawoé',
        '00000000-0000-0000-0000-00000000e001'),
       ('00000000-0000-0000-0000-0000000e0002', 'group', 'Covoiturage Lomé',
        '00000000-0000-0000-0000-00000000e001');

insert into public.conversation_members (conversation_id, user_id, role) values
  ('00000000-0000-0000-0000-0000000e0001', '00000000-0000-0000-0000-00000000e001', 'owner'),
  ('00000000-0000-0000-0000-0000000e0001', '00000000-0000-0000-0000-00000000e002', 'member'),
  ('00000000-0000-0000-0000-0000000e0002', '00000000-0000-0000-0000-00000000e001', 'owner');

-- ---------------------------------------------------------------------------
-- Attribution à l'insertion
-- ---------------------------------------------------------------------------

insert into public.messages (client_id, conversation_id, sender_id, body) values
  ('00000000-0000-0000-0000-00000000f001', '00000000-0000-0000-0000-0000000e0001',
   '00000000-0000-0000-0000-00000000e001', 'premier'),
  ('00000000-0000-0000-0000-00000000f002', '00000000-0000-0000-0000-0000000e0001',
   '00000000-0000-0000-0000-00000000e002', 'deuxième'),
  ('00000000-0000-0000-0000-00000000f003', '00000000-0000-0000-0000-0000000e0001',
   '00000000-0000-0000-0000-00000000e001', 'troisième');

select is(
  (select change_seq from public.messages
    where client_id = '00000000-0000-0000-0000-00000000f001'),
  1::bigint,
  'le premier message reçoit change_seq = 1'
);

select is(
  (select array_agg(change_seq order by seq) from public.messages
    where conversation_id = '00000000-0000-0000-0000-0000000e0001'),
  array[1, 2, 3]::bigint[],
  'trois insertions produisent une suite croissante'
);

select is(
  (select last_change_seq from public.conversations
    where id = '00000000-0000-0000-0000-0000000e0001'),
  3::bigint,
  'le compteur de la conversation suit'
);

-- Le compteur est propre à chaque conversation : sinon un utilisateur actif
-- dans un groupe bavard ferait avancer le curseur de tous ses autres fils.
insert into public.messages (client_id, conversation_id, sender_id, body)
values ('00000000-0000-0000-0000-00000000f004', '00000000-0000-0000-0000-0000000e0002',
        '00000000-0000-0000-0000-00000000e001', 'ailleurs');

select is(
  (select change_seq from public.messages
    where client_id = '00000000-0000-0000-0000-00000000f004'),
  1::bigint,
  'chaque conversation a son propre compteur'
);

-- ---------------------------------------------------------------------------
-- Le point de la fonctionnalité : rattraper une modification
-- ---------------------------------------------------------------------------
-- C'est exactement le cas qu'un curseur sur `seq` ne rattrape pas : le message
-- a déjà été synchronisé, son seq ne bouge pas, et sans `change_seq` le client
-- afficherait éternellement l'ancien texte.

update public.messages set body = 'premier, corrigé'
 where client_id = '00000000-0000-0000-0000-00000000f001';

select is(
  (select change_seq from public.messages
    where client_id = '00000000-0000-0000-0000-00000000f001'),
  4::bigint,
  'une modification fait repasser le message devant le curseur'
);

select is(
  (select seq from public.messages
    where client_id = '00000000-0000-0000-0000-00000000f001'),
  1::bigint,
  'mais son seq ne bouge pas : le fil ne se réordonne pas'
);

-- Un client dont le curseur est à 3 doit revoir ce seul message.
select results_eq(
  $$ select client_id from public.messages
      where conversation_id = '00000000-0000-0000-0000-0000000e0001'
        and change_seq > 3
      order by change_seq $$,
  $$ values ('00000000-0000-0000-0000-00000000f001'::uuid) $$,
  'la reprise depuis le curseur ne ramène que le message modifié'
);

-- ---------------------------------------------------------------------------
-- Suppression logique
-- ---------------------------------------------------------------------------
-- La ligne reste, donc elle revient par le même chemin. C'est ce qui permet à
-- un appareil resté hors ligne d'apprendre qu'un message a été retiré.

update public.messages set deleted_at = now(), body = null
 where client_id = '00000000-0000-0000-0000-00000000f002';

select is(
  (select change_seq from public.messages
    where client_id = '00000000-0000-0000-0000-00000000f002'),
  5::bigint,
  'une suppression fait aussi avancer change_seq'
);

select is(
  (select count(*) from public.messages
    where conversation_id = '00000000-0000-0000-0000-0000000e0001'
      and change_seq > 3),
  2::bigint,
  'la reprise ramène la modification et la suppression'
);

-- ---------------------------------------------------------------------------
-- Indépendance vis-à-vis des non-lus
-- ---------------------------------------------------------------------------
-- La raison d'être d'un compteur séparé : confondre les deux ferait grimper le
-- nombre de messages non lus à chaque correction d'une faute de frappe.

select is(
  (select last_seq from public.conversations
    where id = '00000000-0000-0000-0000-0000000e0001'),
  3::bigint,
  'last_seq compte les messages, pas les écritures'
);

select is(
  (select last_change_seq from public.conversations
    where id = '00000000-0000-0000-0000-0000000e0001'),
  5::bigint,
  'last_change_seq compte les écritures'
);

-- ---------------------------------------------------------------------------
-- Monotonie stricte
-- ---------------------------------------------------------------------------
-- Deux lignes de même change_seq dans une conversation feraient sauter une
-- ligne à tout curseur `>`. C'est la propriété que le verrou de ligne protège.

select is_empty(
  $$ select conversation_id, change_seq
       from public.messages
      group by conversation_id, change_seq
     having count(*) > 1 $$,
  'aucun change_seq n''est attribué deux fois dans une même conversation'
);

-- ---------------------------------------------------------------------------
-- Structure
-- ---------------------------------------------------------------------------

select has_index(
  'public', 'messages', 'messages_conversation_change_seq_idx',
  'l''index de reprise existe'
);

select ok(
  not has_function_privilege('anon', 'public.assign_message_change_seq()', 'execute')
  and not has_function_privilege('authenticated', 'public.assign_message_change_seq()', 'execute'),
  'la fonction de trigger n''est exposée à personne'
);

-- La vue doit porter le compteur : c'est ce qui permet au client de repérer un
-- curseur en avance sur le serveur, seul cas où il doit tout reprendre.
select has_column(
  'public', 'conversation_overview', 'last_change_seq',
  'conversation_overview expose last_change_seq'
);

select * from finish();
rollback;
