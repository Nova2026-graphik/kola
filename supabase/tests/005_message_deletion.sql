-- Régression — la suppression logique doit fonctionner au-delà de la fenêtre
-- de modification.
--
-- Ce fichier existe à cause d'un défaut réel, introduit par les migrations #10
-- et #14 et resté invisible aux tests de ces issues.
--
-- Deux garde-fous se contredisaient. `messages_body_required` exigeait un corps
-- non vide pour les messages `text`. `enforce_message_edit_window` refusait
-- toute modification du corps au-delà de quinze minutes. Or une suppression
-- logique met précisément le corps à NULL : elle était donc rejetée par la
-- contrainte, et lue comme une édition tardive par le trigger.
--
-- **Il était impossible de supprimer un message de plus de quinze minutes.**
--
-- Pourquoi les tests de #14 ne l'ont pas vu : ils marquaient `deleted_at` sans
-- toucher au corps. Le chemin réel du repository (#28) met les deux à jour
-- ensemble — le test reproduisait une suppression qui n'existe pas.
--
-- Le défaut a été trouvé par le script de seed (#17), qui supprime un message
-- vieux de vingt heures.

begin;
create extension if not exists pgtap with schema extensions;
select plan(9);

-- ---------------------------------------------------------------------------
-- Fixtures
-- ---------------------------------------------------------------------------

insert into auth.users (id) values ('00000000-0000-0000-0000-0000000d0001');

insert into public.conversations (id, type, title, owner_id)
values ('00000000-0000-0000-0000-0000000d1001', 'group', 'Régression',
        '00000000-0000-0000-0000-0000000d0001');

insert into public.conversation_members (conversation_id, user_id, role)
values ('00000000-0000-0000-0000-0000000d1001', '00000000-0000-0000-0000-0000000d0001', 'owner');

-- Un message ancien : bien au-delà de la fenêtre de quinze minutes.
insert into public.messages (client_id, conversation_id, sender_id, body, created_at)
values ('00000000-0000-0000-0000-0000000d2001', '00000000-0000-0000-0000-0000000d1001',
        '00000000-0000-0000-0000-0000000d0001', 'message ancien',
        now() - interval '20 hours');

-- Un message récent, pour la fenêtre d'édition.
insert into public.messages (client_id, conversation_id, sender_id, body)
values ('00000000-0000-0000-0000-0000000d2002', '00000000-0000-0000-0000-0000000d1001',
        '00000000-0000-0000-0000-0000000d0001', 'message récent');

-- ---------------------------------------------------------------------------
-- Le cas qui était cassé
-- ---------------------------------------------------------------------------

select lives_ok(
  $$ update public.messages
        set deleted_at = now(), body = null
      where client_id = '00000000-0000-0000-0000-0000000d2001' $$,
  'un message ancien peut être supprimé pour tous — chemin réel du repository'
);

select is(
  (select body from public.messages where client_id = '00000000-0000-0000-0000-0000000d2001'),
  null,
  'la suppression vide bien le corps'
);

select is(
  (select seq from public.messages where client_id = '00000000-0000-0000-0000-0000000d2001'),
  1::bigint,
  'le seq est conservé — la reprise par curseur ne doit pas casser'
);

-- ---------------------------------------------------------------------------
-- Ce qui doit rester interdit
-- ---------------------------------------------------------------------------

select throws_ok(
  $$ update public.messages set body = 'contenu ressuscité'
      where client_id = '00000000-0000-0000-0000-0000000d2001' $$,
  '23514',
  null,
  'un message supprimé ne se modifie plus'
);

select throws_ok(
  $$ update public.messages set deleted_at = null
      where client_id = '00000000-0000-0000-0000-0000000d2001' $$,
  '23514',
  null,
  'une suppression ne se défait pas — un message effacé chez tous ne réapparaît pas'
);

-- Une suppression doit vider le corps, pas le conserver : sinon le contenu
-- resterait lisible par un client qui ignore `deleted_at`.
select throws_ok(
  $$ update public.messages set deleted_at = now()
      where client_id = '00000000-0000-0000-0000-0000000d2002' $$,
  '23514',
  null,
  'une suppression qui laisse le corps intact est refusée'
);

-- ---------------------------------------------------------------------------
-- La fenêtre d'édition reste en vigueur
-- ---------------------------------------------------------------------------

select lives_ok(
  $$ update public.messages set body = 'corrigé à temps'
      where client_id = '00000000-0000-0000-0000-0000000d2002' $$,
  'un message récent reste modifiable'
);

select isnt(
  (select edited_at from public.messages where client_id = '00000000-0000-0000-0000-0000000d2002'),
  null,
  'la modification renseigne edited_at'
);

insert into public.messages (client_id, conversation_id, sender_id, body, created_at)
values ('00000000-0000-0000-0000-0000000d2003', '00000000-0000-0000-0000-0000000d1001',
        '00000000-0000-0000-0000-0000000d0001', 'trop vieux pour être corrigé',
        now() - interval '2 hours');

select throws_ok(
  $$ update public.messages set body = 'tentative tardive'
      where client_id = '00000000-0000-0000-0000-0000000d2003' $$,
  '23514',
  null,
  'la fenêtre de modification reste appliquée pour une vraie édition'
);

select * from finish();
rollback;
