-- #58 — file de notifications : qui reçoit quoi, et qui ne reçoit rien
--
-- L'issue le dit elle-même : c'est le point de la V1 où une erreur a le plus de
-- conséquences. La fonction Edge s'exécute avec la clé de service et contourne
-- RLS ; si une règle d'accès n'est pas appliquée ici, elle ne l'est nulle part,
-- et l'aperçu d'un message privé part chez quelqu'un qui n'y a pas droit.
--
-- Chaque exclusion est donc vérifiée séparément. Un test unique sur « la bonne
-- personne reçoit » passerait même si les trois exclusions étaient cassées.

begin;
create extension if not exists pgtap with schema extensions;
select plan(13);

-- ---------------------------------------------------------------------------
-- Fixtures : un expéditeur, et quatre raisons de ne pas être notifié
-- ---------------------------------------------------------------------------

insert into auth.users (id) values
  ('00000000-0000-0000-0000-00000000a001'),  -- expéditeur
  ('00000000-0000-0000-0000-00000000a002'),  -- destinataire ordinaire
  ('00000000-0000-0000-0000-00000000a003'),  -- a mis en sourdine
  ('00000000-0000-0000-0000-00000000a004'),  -- a bloqué l'expéditeur
  ('00000000-0000-0000-0000-00000000a005');  -- a déjà tout lu

update public.profiles set display_name = 'Ama'
 where id = '00000000-0000-0000-0000-00000000a001';

insert into public.devices (user_id, push_token, platform) values
  ('00000000-0000-0000-0000-00000000a001', 'ExpoTok[expediteur]', 'android'),
  ('00000000-0000-0000-0000-00000000a002', 'ExpoTok[ordinaire]',  'android'),
  ('00000000-0000-0000-0000-00000000a003', 'ExpoTok[sourdine]',   'android'),
  ('00000000-0000-0000-0000-00000000a004', 'ExpoTok[bloqueur]',   'android'),
  ('00000000-0000-0000-0000-00000000a005', 'ExpoTok[alu]',        'android');

select set_config('kola.suppress_system_messages', 'on', true);

insert into public.conversations (id, type, title, owner_id)
values ('00000000-0000-0000-0000-00000000ac01', 'group', 'Tontine',
        '00000000-0000-0000-0000-00000000a001');

insert into public.conversation_members (conversation_id, user_id, role) values
  ('00000000-0000-0000-0000-00000000ac01', '00000000-0000-0000-0000-00000000a001', 'owner'),
  ('00000000-0000-0000-0000-00000000ac01', '00000000-0000-0000-0000-00000000a002', 'member'),
  ('00000000-0000-0000-0000-00000000ac01', '00000000-0000-0000-0000-00000000a003', 'member'),
  ('00000000-0000-0000-0000-00000000ac01', '00000000-0000-0000-0000-00000000a004', 'member'),
  ('00000000-0000-0000-0000-00000000ac01', '00000000-0000-0000-0000-00000000a005', 'member');

select set_config('kola.suppress_system_messages', 'off', true);

update public.conversation_members set muted_until = now() + interval '1 day'
 where conversation_id = '00000000-0000-0000-0000-00000000ac01'
   and user_id = '00000000-0000-0000-0000-00000000a003';

insert into public.blocks (blocker_id, blocked_id)
values ('00000000-0000-0000-0000-00000000a004', '00000000-0000-0000-0000-00000000a001');

-- ---------------------------------------------------------------------------
-- Mise en file
-- ---------------------------------------------------------------------------

insert into public.messages (client_id, conversation_id, sender_id, kind, body)
values ('00000000-0000-0000-0000-00000000ad00', '00000000-0000-0000-0000-00000000ac01',
        '00000000-0000-0000-0000-00000000a001', 'system', '{"type":"created"}');

select is(
  (select count(*) from public.notification_queue
    where conversation_id = '00000000-0000-0000-0000-00000000ac01'),
  0::bigint,
  'un message système ne met rien en file'
);

insert into public.messages (client_id, conversation_id, sender_id, kind, body) values
  ('00000000-0000-0000-0000-00000000ad01', '00000000-0000-0000-0000-00000000ac01',
   '00000000-0000-0000-0000-00000000a001', 'text', 'premier'),
  ('00000000-0000-0000-0000-00000000ad02', '00000000-0000-0000-0000-00000000ac01',
   '00000000-0000-0000-0000-00000000a001', 'text', 'deuxième'),
  ('00000000-0000-0000-0000-00000000ad03', '00000000-0000-0000-0000-00000000ac01',
   '00000000-0000-0000-0000-00000000a001', 'text', 'troisième');

-- Le critère d'acceptation : dix messages rapprochés produisent UNE
-- notification, pas dix. Chaque envoi réveille la radio du téléphone.
select is(
  (select count(*) from public.notification_queue
    where conversation_id = '00000000-0000-0000-0000-00000000ac01'),
  1::bigint,
  'trois messages ne produisent qu''une ligne de file'
);

select is(
  (select pending_count from public.notification_queue
    where conversation_id = '00000000-0000-0000-0000-00000000ac01'),
  3,
  'le compteur suit le nombre de messages en attente'
);

-- ---------------------------------------------------------------------------
-- La fenêtre de silence
-- ---------------------------------------------------------------------------

select is_empty(
  $$ select recipient_id from public.claim_notifications(100) $$,
  'rien ne part tant que la fenêtre de regroupement n''est pas écoulée'
);

-- Quelqu'un a lu la conversation entre-temps : il ne doit pas être réveillé
-- pour ce qu'il vient de voir.
--
-- Le curseur est DÉRIVÉ de `last_seq`, pas écrit en dur. Le message système en
-- a consommé un : les trois messages texte occupent les rangs 2 à 4, et un 3
-- écrit à la main laisserait passer le dernier. C'est exactement l'erreur que
-- ce test a attrapée la première fois qu'il a tourné.
update public.conversation_members m set last_read_seq = c.last_seq
  from public.conversations c
 where c.id = m.conversation_id
   and m.conversation_id = '00000000-0000-0000-0000-00000000ac01'
   and m.user_id = '00000000-0000-0000-0000-00000000a005';

update public.notification_queue set last_queued_at = now() - interval '30 seconds'
 where conversation_id = '00000000-0000-0000-0000-00000000ac01';

create temp table reclame as
select * from public.claim_notifications(100);

-- ---------------------------------------------------------------------------
-- Qui reçoit, et surtout qui ne reçoit pas
-- ---------------------------------------------------------------------------
-- Chaque exclusion est vérifiée séparément : un test unique sur « la bonne
-- personne reçoit » passerait même si les trois autres étaient cassées.

select is(
  (select count(*) from reclame),
  1::bigint,
  'une seule personne sur cinq est notifiée'
);

select is(
  (select recipient_id from reclame),
  '00000000-0000-0000-0000-00000000a002'::uuid,
  'c''est bien le destinataire ordinaire'
);

select is_empty(
  $$ select 1 from reclame where recipient_id = '00000000-0000-0000-0000-00000000a001' $$,
  'l''expéditeur ne se notifie pas lui-même'
);

select is_empty(
  $$ select 1 from reclame where recipient_id = '00000000-0000-0000-0000-00000000a003' $$,
  'une conversation en sourdine ne déclenche rien'
);

-- La fonction Edge contourne RLS : si le blocage n'est pas appliqué ici, il ne
-- l'est nulle part, et l'aperçu part chez quelqu'un qui a demandé à ne plus
-- rien recevoir de cette personne.
select is_empty(
  $$ select 1 from reclame where recipient_id = '00000000-0000-0000-0000-00000000a004' $$,
  'un utilisateur bloqué ne peut pas déclencher de notification'
);

select is_empty(
  $$ select 1 from reclame where recipient_id = '00000000-0000-0000-0000-00000000a005' $$,
  'qui a déjà lu n''est pas réveillé'
);

-- ---------------------------------------------------------------------------
-- Contenu
-- ---------------------------------------------------------------------------

select is(
  (select body from reclame),
  'Ama · 3 nouveaux messages',
  'le corps annonce le regroupement plutôt que le dernier message'
);

select is(
  (select push_tokens from reclame),
  array['ExpoTok[ordinaire]'],
  'seul le jeton du destinataire est rendu'
);

-- ---------------------------------------------------------------------------
-- La file est vidée
-- ---------------------------------------------------------------------------
-- Sinon la passe suivante renotifierait tout le monde pour les mêmes messages.

select is(
  (select count(*) from public.notification_queue
    where conversation_id = '00000000-0000-0000-0000-00000000ac01'),
  0::bigint,
  'réclamer vide la file'
);

select * from finish();
rollback;
