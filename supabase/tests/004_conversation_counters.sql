-- #15 — aperçu dénormalisé et compteurs de non-lus
--
-- La liste des conversations est l'écran le plus consulté. Ces compteurs
-- doivent être exacts sans coûter une agrégation sur `messages` à chaque
-- affichage.

begin;
create extension if not exists pgtap with schema extensions;
select plan(13);

-- ---------------------------------------------------------------------------
-- Fixtures
-- ---------------------------------------------------------------------------

insert into auth.users (id) values
  ('00000000-0000-0000-0000-00000000f001'),
  ('00000000-0000-0000-0000-00000000f002');

update public.profiles set username = 'test_ama_004', display_name = 'Ama'
 where id = '00000000-0000-0000-0000-00000000f001';
update public.profiles set username = 'test_kodjo_004', display_name = 'Kodjo'
 where id = '00000000-0000-0000-0000-00000000f002';

insert into public.conversations (id, type, title, owner_id)
values ('00000000-0000-0000-0000-0000000e0001', 'group', 'Association',
        '00000000-0000-0000-0000-00000000f001');

insert into public.conversation_members (conversation_id, user_id, role) values
  ('00000000-0000-0000-0000-0000000e0001', '00000000-0000-0000-0000-00000000f001', 'owner'),
  ('00000000-0000-0000-0000-0000000e0001', '00000000-0000-0000-0000-00000000f002', 'member');

-- ---------------------------------------------------------------------------
-- Aperçu dénormalisé
-- ---------------------------------------------------------------------------

select is(
  (select last_message_at from public.conversations
    where id = '00000000-0000-0000-0000-0000000e0001'),
  null,
  'une conversation sans message n''a pas de date de dernier message'
);

insert into public.messages (client_id, conversation_id, sender_id, body)
values ('00000000-0000-0000-0000-000000009001', '00000000-0000-0000-0000-0000000e0001',
        '00000000-0000-0000-0000-00000000f001', 'Réunion samedi à 15 h');

select isnt(
  (select last_message_at from public.conversations
    where id = '00000000-0000-0000-0000-0000000e0001'),
  null,
  'insérer un message renseigne last_message_at dans la même transaction'
);

select is(
  (select last_message_preview from public.conversations
    where id = '00000000-0000-0000-0000-0000000e0001'),
  'Réunion samedi à 15 h',
  'l''aperçu du dernier message est dénormalisé'
);

-- L'aperçu est tronqué côté serveur : la liste des conversations ne doit pas
-- transférer le corps entier des derniers messages sur un réseau facturé.
insert into public.messages (client_id, conversation_id, sender_id, body)
values ('00000000-0000-0000-0000-000000009002', '00000000-0000-0000-0000-0000000e0001',
        '00000000-0000-0000-0000-00000000f002', repeat('a', 500));

select is(
  (select length(last_message_preview) from public.conversations
    where id = '00000000-0000-0000-0000-0000000e0001'),
  120,
  'l''aperçu est tronqué à 120 caractères côté serveur'
);

select is(
  (select last_message_sender_id from public.conversations
    where id = '00000000-0000-0000-0000-0000000e0001'),
  '00000000-0000-0000-0000-00000000f002'::uuid,
  'l''auteur du dernier message est dénormalisé'
);

-- Supprimer le dernier message doit faire remonter le précédent.
-- La suppression vide le corps : c'est le chemin réel du repository (#28), et
-- ce que la migration 20260910120009 impose désormais.
update public.messages set deleted_at = now(), body = null
 where client_id = '00000000-0000-0000-0000-000000009002';

select is(
  (select last_message_preview from public.conversations
    where id = '00000000-0000-0000-0000-0000000e0001'),
  'Réunion samedi à 15 h',
  'supprimer le dernier message fait remonter l''aperçu du précédent'
);

-- ---------------------------------------------------------------------------
-- Compteurs de non-lus
-- ---------------------------------------------------------------------------

set local role authenticated;
set local request.jwt.claims to '{"sub":"00000000-0000-0000-0000-00000000f002","role":"authenticated"}';

select is(
  public.unread_count('00000000-0000-0000-0000-0000000e0001'),
  2::bigint,
  'les deux messages sont non lus au départ'
);

select is(
  public.mark_conversation_read('00000000-0000-0000-0000-0000000e0001', 2::bigint),
  2::bigint,
  'marquer comme lu avance le curseur de lecture'
);

select is(
  public.unread_count('00000000-0000-0000-0000-0000000e0001'),
  0::bigint,
  'une conversation entièrement lue affiche zéro non-lu'
);

-- Un accusé en retard, arrivé après une salve de synchronisation, ne doit pas
-- ressusciter des non-lus déjà vus.
select is(
  public.mark_conversation_read('00000000-0000-0000-0000-0000000e0001', 1::bigint),
  2::bigint,
  'marquer comme lu avec un seq inférieur ne fait pas reculer le curseur'
);

-- ---------------------------------------------------------------------------
-- Vue de la liste des conversations
-- ---------------------------------------------------------------------------

select is(
  (select unread_count from public.conversation_overview
    where id = '00000000-0000-0000-0000-0000000e0001'),
  0::bigint,
  'la vue expose le compte de non-lus de l''utilisateur courant'
);

-- La vue est security_invoker : elle respecte les policies de l'appelant.
set local request.jwt.claims to '{"sub":"00000000-0000-0000-0000-00000000f001","role":"authenticated"}';

select is(
  (select unread_count from public.conversation_overview
    where id = '00000000-0000-0000-0000-0000000e0001'),
  2::bigint,
  'chaque membre voit son propre compte de non-lus dans la vue'
);

-- Le marquage comme lu d'une conversation dont on n'est pas membre est refusé.
set local request.jwt.claims to '{"sub":"00000000-0000-0000-0000-00000000f001","role":"authenticated"}';

select throws_ok(
  $$ select public.mark_conversation_read('00000000-0000-0000-0000-00000000dead', 5::bigint) $$,
  '42501',
  null,
  'marquer comme lue une conversation étrangère est refusé'
);

reset role;
select * from finish();
rollback;
