-- #17 — données de démonstration
--
-- Développer la liste des conversations sur une base vide ne montre jamais les
-- cas qui cassent : le nom qui déborde, la conversation à cinq mille messages,
-- l'aperçu vide, le message supprimé. Ce jeu de données les contient tous.
--
-- ⚠️ NE S'EXÉCUTE QUE SUR UNE BASE LOCALE. `supabase db reset` l'applique
-- automatiquement après les migrations ; il n'est jamais poussé en production.
-- Il insère dans `auth.users`, ce qui exige des privilèges que le client mobile
-- n'a pas et n'aura jamais.

-- Sécurité : refuse de s'exécuter sur une base qui contient déjà des comptes
-- réels. Un seed lancé par erreur sur un environnement partagé ferait plus de
-- dégâts qu'il n'apporte de confort.
do $$
begin
  if exists (
    select 1 from auth.users
     where id::text not like '00000000-0000-4000-a000-%'
  ) then
    raise exception
      'des comptes non issus du seed existent déjà : refus de peupler cette base';
  end if;
end;
$$;

begin;

-- ---------------------------------------------------------------------------
-- Comptes
-- ---------------------------------------------------------------------------
-- Les identifiants suivent tous le préfixe 00000000-0000-4000-a000- pour que la
-- garde ci-dessus puisse les reconnaître.

insert into auth.users (id, phone) values
  ('00000000-0000-4000-a000-000000000001', '+22890000001'),
  ('00000000-0000-4000-a000-000000000002', '+22890000002'),
  ('00000000-0000-4000-a000-000000000003', '+22890000003'),
  ('00000000-0000-4000-a000-000000000004', '+22890000004'),
  ('00000000-0000-4000-a000-000000000005', '+22890000005'),
  ('00000000-0000-4000-a000-000000000006', '+22890000006'),
  ('00000000-0000-4000-a000-000000000007', '+22890000007'),
  ('00000000-0000-4000-a000-000000000008', '+22890000008'),
  ('00000000-0000-4000-a000-000000000009', '+22890000009'),
  ('00000000-0000-4000-a000-000000000010', '+22890000010');

-- Le trigger `on_auth_user_created` a créé les profils : on les complète.
update public.profiles set username = 'kofi', display_name = 'Kofi Mensah',
       bio = 'Développeur à Lomé'
 where id = '00000000-0000-4000-a000-000000000001';

update public.profiles set username = 'ama', display_name = 'Ama Doe'
 where id = '00000000-0000-4000-a000-000000000002';

update public.profiles set username = 'kodjo', display_name = 'Kodjo Adjovi'
 where id = '00000000-0000-4000-a000-000000000003';

update public.profiles set username = 'afi', display_name = 'Afi Kossi'
 where id = '00000000-0000-4000-a000-000000000004';

update public.profiles set username = 'sena', display_name = 'Sena Agbeko'
 where id = '00000000-0000-4000-a000-000000000005';

update public.profiles set username = 'yao', display_name = 'Yao Lawson'
 where id = '00000000-0000-4000-a000-000000000006';

update public.profiles set username = 'esi', display_name = 'Esi Amenyo'
 where id = '00000000-0000-4000-a000-000000000007';

-- Cas limite : nom affiché à la longueur maximale. Doit se tronquer proprement
-- dans la liste des conversations comme dans l'en-tête.
update public.profiles set username = 'komlan',
       display_name = 'Komlan Kwadzo Mawuli Adjovi-Agbeko de Tsévié'
 where id = '00000000-0000-4000-a000-000000000008';

-- Cas limite : profil sans pseudo ni nom, tel qu'il existe juste après une
-- inscription par OTP SMS et avant l'écran de création de profil (#22).
-- L'interface doit afficher quelque chose plutôt que « null ».
update public.profiles set username = null, display_name = null
 where id = '00000000-0000-4000-a000-000000000009';

update public.profiles set username = 'spam_account', display_name = 'Compte douteux'
 where id = '00000000-0000-4000-a000-000000000010';

-- ---------------------------------------------------------------------------
-- Conversation directe, courte
-- ---------------------------------------------------------------------------

insert into public.conversations (id, type, dm_key, owner_id) values
  ('00000000-0000-4000-b000-000000000001', 'dm',
   '00000000-0000-4000-a000-000000000001:00000000-0000-4000-a000-000000000002',
   '00000000-0000-4000-a000-000000000001');

insert into public.conversation_members (conversation_id, user_id, role) values
  ('00000000-0000-4000-b000-000000000001', '00000000-0000-4000-a000-000000000001', 'owner'),
  ('00000000-0000-4000-b000-000000000001', '00000000-0000-4000-a000-000000000002', 'member');

insert into public.messages (client_id, conversation_id, sender_id, body, created_at) values
  ('00000000-0000-4000-c000-000000000001', '00000000-0000-4000-b000-000000000001',
   '00000000-0000-4000-a000-000000000001', 'Bonsoir Ama, tu es rentrée ?',
   now() - interval '3 hours'),
  ('00000000-0000-4000-c000-000000000002', '00000000-0000-4000-b000-000000000001',
   '00000000-0000-4000-a000-000000000002', 'Oui, il y avait beaucoup de circulation à Bè',
   now() - interval '2 hours 50 minutes'),
  ('00000000-0000-4000-c000-000000000003', '00000000-0000-4000-b000-000000000001',
   '00000000-0000-4000-a000-000000000001', 'On se voit demain au bureau alors',
   now() - interval '2 hours 45 minutes');

-- ---------------------------------------------------------------------------
-- Groupe actif, avec rôles variés
-- ---------------------------------------------------------------------------

insert into public.conversations (id, type, title, owner_id) values
  ('00000000-0000-4000-b000-000000000002', 'group', 'Tontine du quartier',
   '00000000-0000-4000-a000-000000000003');

insert into public.conversation_members (conversation_id, user_id, role) values
  ('00000000-0000-4000-b000-000000000002', '00000000-0000-4000-a000-000000000003', 'owner'),
  ('00000000-0000-4000-b000-000000000002', '00000000-0000-4000-a000-000000000001', 'admin'),
  ('00000000-0000-4000-b000-000000000002', '00000000-0000-4000-a000-000000000002', 'member'),
  ('00000000-0000-4000-b000-000000000002', '00000000-0000-4000-a000-000000000004', 'member'),
  ('00000000-0000-4000-b000-000000000002', '00000000-0000-4000-a000-000000000005', 'member'),
  ('00000000-0000-4000-b000-000000000002', '00000000-0000-4000-a000-000000000008', 'member');

insert into public.messages (client_id, conversation_id, sender_id, body, created_at) values
  ('00000000-0000-4000-c000-000000000010', '00000000-0000-4000-b000-000000000002',
   '00000000-0000-4000-a000-000000000003', 'La réunion est fixée à samedi 15 h',
   now() - interval '2 days'),
  ('00000000-0000-4000-c000-000000000011', '00000000-0000-4000-b000-000000000002',
   '00000000-0000-4000-a000-000000000004', 'Ça marche pour moi',
   now() - interval '2 days' + interval '5 minutes'),
  ('00000000-0000-4000-c000-000000000012', '00000000-0000-4000-b000-000000000002',
   '00000000-0000-4000-a000-000000000005', 'Je serai un peu en retard',
   now() - interval '2 days' + interval '12 minutes');

-- Réponse citée, pour vérifier l'affichage de la citation et le saut vers le
-- message d'origine (#33).
insert into public.messages
  (client_id, conversation_id, sender_id, body, reply_to_id, created_at)
select '00000000-0000-4000-c000-000000000013', '00000000-0000-4000-b000-000000000002',
       '00000000-0000-4000-a000-000000000001', 'Pas de souci, on t''attend', m.id,
       now() - interval '2 days' + interval '15 minutes'
  from public.messages m
 where m.client_id = '00000000-0000-4000-c000-000000000012';

-- Message modifié, puis message supprimé pour tous : la bulle doit afficher
-- « modifié » dans un cas et « message supprimé » dans l'autre.
insert into public.messages (client_id, conversation_id, sender_id, body, created_at, edited_at)
values ('00000000-0000-4000-c000-000000000014', '00000000-0000-4000-b000-000000000002',
        '00000000-0000-4000-a000-000000000003', 'Finalement ce sera à 16 h',
        now() - interval '1 day', now() - interval '1 day' + interval '2 minutes');

insert into public.messages (client_id, conversation_id, sender_id, body, created_at)
values ('00000000-0000-4000-c000-000000000015', '00000000-0000-4000-b000-000000000002',
        '00000000-0000-4000-a000-000000000008', 'Message à supprimer',
        now() - interval '20 hours');

update public.messages
   set deleted_at = now() - interval '19 hours', body = null
 where client_id = '00000000-0000-4000-c000-000000000015';

-- Cas limite : message très long, qui doit se replier sans casser la mise en page.
insert into public.messages (client_id, conversation_id, sender_id, body, created_at)
values ('00000000-0000-4000-c000-000000000016', '00000000-0000-4000-b000-000000000002',
        '00000000-0000-4000-a000-000000000004',
        repeat('Ceci est un message volontairement très long pour éprouver le repli du texte dans la bulle. ', 12),
        now() - interval '10 hours');

-- Réactions, dont un même emoji posé par plusieurs personnes : elles doivent
-- se regrouper avec un compteur (#35).
insert into public.reactions (message_id, user_id, emoji)
select m.id, u.user_id, u.emoji
  from public.messages m
  cross join (values
    ('00000000-0000-4000-a000-000000000001'::uuid, '👍'),
    ('00000000-0000-4000-a000-000000000002'::uuid, '👍'),
    ('00000000-0000-4000-a000-000000000004'::uuid, '❤️')
  ) as u(user_id, emoji)
 where m.client_id = '00000000-0000-4000-c000-000000000010';

-- ---------------------------------------------------------------------------
-- Conversation vide
-- ---------------------------------------------------------------------------
-- Doit apparaître dans la liste sans aperçu ni horodatage, sans planter le tri.

insert into public.conversations (id, type, title, owner_id) values
  ('00000000-0000-4000-b000-000000000003', 'group', 'Groupe sans message',
   '00000000-0000-4000-a000-000000000001');

insert into public.conversation_members (conversation_id, user_id, role) values
  ('00000000-0000-4000-b000-000000000003', '00000000-0000-4000-a000-000000000001', 'owner'),
  ('00000000-0000-4000-b000-000000000003', '00000000-0000-4000-a000-000000000007', 'member');

-- ---------------------------------------------------------------------------
-- Groupe au titre très long
-- ---------------------------------------------------------------------------

insert into public.conversations (id, type, title, owner_id) values
  ('00000000-0000-4000-b000-000000000004', 'group',
   'Association des parents d''élèves du quartier de Tokoin Hôpital, section Est',
   '00000000-0000-4000-a000-000000000002');

insert into public.conversation_members (conversation_id, user_id, role) values
  ('00000000-0000-4000-b000-000000000004', '00000000-0000-4000-a000-000000000002', 'owner'),
  ('00000000-0000-4000-b000-000000000004', '00000000-0000-4000-a000-000000000001', 'member');

insert into public.messages (client_id, conversation_id, sender_id, body, created_at)
values ('00000000-0000-4000-c000-000000000020', '00000000-0000-4000-b000-000000000004',
        '00000000-0000-4000-a000-000000000002', 'Bienvenue à tous',
        now() - interval '5 days');

-- ---------------------------------------------------------------------------
-- Conversation volumineuse : 5 000 messages
-- ---------------------------------------------------------------------------
-- Éprouve la pagination par curseur et la liste virtualisée (#30). Le budget
-- de l'ADR-0006 exige une ouverture en moins d'une seconde sur ce volume.

insert into public.conversations (id, type, title, owner_id) values
  ('00000000-0000-4000-b000-000000000005', 'group', 'Historique volumineux',
   '00000000-0000-4000-a000-000000000001');

insert into public.conversation_members (conversation_id, user_id, role) values
  ('00000000-0000-4000-b000-000000000005', '00000000-0000-4000-a000-000000000001', 'owner'),
  ('00000000-0000-4000-b000-000000000005', '00000000-0000-4000-a000-000000000002', 'member'),
  ('00000000-0000-4000-b000-000000000005', '00000000-0000-4000-a000-000000000003', 'member');

insert into public.messages (client_id, conversation_id, sender_id, body, created_at)
select
  extensions.gen_random_uuid(),
  '00000000-0000-4000-b000-000000000005',
  -- Alterne les auteurs pour que le groupement visuel des messages consécutifs
  -- ait quelque chose à grouper.
  (array[
    '00000000-0000-4000-a000-000000000001',
    '00000000-0000-4000-a000-000000000002',
    '00000000-0000-4000-a000-000000000003'
  ]::uuid[])[1 + (i % 3)],
  'Message numéro ' || i,
  -- Étalés sur environ six mois, pour que les séparateurs de date aient du sens.
  now() - interval '180 days' + (i * interval '52 minutes')
from generate_series(1, 5000) i;

-- ---------------------------------------------------------------------------
-- Non-lus
-- ---------------------------------------------------------------------------
-- Kodjo a tout lu, Ama a du retard, Kofi n'a rien ouvert : les trois cas que la
-- liste des conversations doit distinguer.

update public.conversation_members
   set last_read_seq = (select last_seq from public.conversations
                         where id = '00000000-0000-4000-b000-000000000005')
 where conversation_id = '00000000-0000-4000-b000-000000000005'
   and user_id = '00000000-0000-4000-a000-000000000003';

update public.conversation_members
   set last_read_seq = 4980
 where conversation_id = '00000000-0000-4000-b000-000000000005'
   and user_id = '00000000-0000-4000-a000-000000000002';

-- ---------------------------------------------------------------------------
-- Modération
-- ---------------------------------------------------------------------------

-- Kofi a bloqué le compte douteux : ses messages ne doivent plus lui parvenir,
-- et son profil ne doit plus être lisible (#65).
insert into public.blocks (blocker_id, blocked_id) values
  ('00000000-0000-4000-a000-000000000001', '00000000-0000-4000-a000-000000000010');

insert into public.reports (reporter_id, target_type, target_id, reason, content_snapshot)
values ('00000000-0000-4000-a000-000000000002', 'profile',
        '00000000-0000-4000-a000-000000000010',
        'Envoi répété de messages non sollicités',
        'Gagnez de l''argent facilement, contactez-moi');

-- ---------------------------------------------------------------------------
-- Contacts
-- ---------------------------------------------------------------------------
-- Aucun numéro en clair, conformément à #68 : seulement une empreinte.

insert into public.contacts (user_id, contact_user_id, phone_hash, source) values
  ('00000000-0000-4000-a000-000000000001', '00000000-0000-4000-a000-000000000002',
   encode(extensions.digest('demo-pepper|+22890000002', 'sha256'), 'hex'), 'address_book'),
  ('00000000-0000-4000-a000-000000000001', '00000000-0000-4000-a000-000000000003',
   encode(extensions.digest('demo-pepper|+22890000003', 'sha256'), 'hex'), 'address_book'),
  ('00000000-0000-4000-a000-000000000002', '00000000-0000-4000-a000-000000000001',
   encode(extensions.digest('demo-pepper|+22890000001', 'sha256'), 'hex'), 'username_search');

commit;

-- ---------------------------------------------------------------------------
-- Récapitulatif
-- ---------------------------------------------------------------------------

do $$
declare
  n_users         int;
  n_conversations int;
  n_messages      int;
begin
  select count(*) into n_users from public.profiles;
  select count(*) into n_conversations from public.conversations;
  select count(*) into n_messages from public.messages;

  raise notice 'seed : % comptes, % conversations, % messages',
    n_users, n_conversations, n_messages;
end;
$$;
