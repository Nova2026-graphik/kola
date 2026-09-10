-- Privilèges d'exécution des fonctions SECURITY DEFINER
--
-- Une fonction SECURITY DEFINER s'exécute avec les droits de son propriétaire :
-- elle traverse RLS. Qui peut l'appeler est donc une question de sécurité, pas
-- de confort.
--
-- Supabase pose un `ALTER DEFAULT PRIVILEGES` qui accorde EXECUTE à `anon` sur
-- toute nouvelle fonction du schéma public. Un `revoke ... from public` ne le
-- retire pas : le grant à `anon` est nommé, il faut le nommer pour l'ôter.
-- Le piège est silencieux — il ne se voit ni à la lecture du code, ni à
-- l'exécution : la fonction marche, elle est juste ouverte à tous.
--
-- Ces tests fixent la règle sous une forme qui échoue quand on l'oublie.

begin;
create extension if not exists pgtap with schema extensions;
select plan(7);



-- ---------------------------------------------------------------------------
-- La règle sans exception : rien de SECURITY DEFINER n'est ouvert à `anon`
-- ---------------------------------------------------------------------------
-- Formulé en négatif et sans liste à tenir à jour : une fonction ajoutée
-- demain tombe dedans toute seule. C'est l'intérêt d'un test structurel plutôt
-- que d'un test par fonction.

select is_empty(
  $$ select p.proname
       from pg_proc p
       join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public'
        and p.prosecdef
        and p.prokind = 'f'
        and has_function_privilege('anon', p.oid, 'execute') $$,
  'aucune fonction SECURITY DEFINER n''est exécutable par anon'
);

-- ---------------------------------------------------------------------------
-- Les fonctions de trigger ne sont exposées à personne
-- ---------------------------------------------------------------------------
-- PostgreSQL refuse déjà leur appel direct (`0A000 : trigger functions can
-- only be called as triggers`) : les révoquer ne ferme pas une brèche. Ce
-- qu'on protège ici, c'est la lisibilité du rapport d'advisors — huit
-- avertissements permanents et inoffensifs, et le neuvième, celui qui compte,
-- passe inaperçu.

select is_empty(
  $$ select p.proname
       from pg_proc p
       join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public'
        and p.prosecdef
        and p.prorettype = 'trigger'::regtype
        and (has_function_privilege('anon', p.oid, 'execute')
          or has_function_privilege('authenticated', p.oid, 'execute')) $$,
  'aucune fonction de trigger n''est exécutable par anon ni authenticated'
);

-- Révoquer EXECUTE ne désarme pas les triggers : ils s'exécutent sous le
-- propriétaire de la table, pas sous le rôle appelant. La preuve tient en une
-- ligne — le trigger est toujours attaché, et les tests 002, 004 et 005
-- vérifient qu'il produit toujours son effet.
select isnt_empty(
  $$ select tgname from pg_trigger
      where not tgisinternal
        and tgrelid = 'public.messages'::regclass $$,
  'les triggers de messages restent attachés après la révocation'
);

-- ---------------------------------------------------------------------------
-- Ce que `authenticated` DOIT pouvoir appeler
-- ---------------------------------------------------------------------------
-- L'inverse du test précédent : révoquer trop casse l'application en silence.
-- Les helpers sont appelés depuis les policies RLS, qui s'évaluent sous
-- l'identité de l'appelant — sans EXECUTE, plus aucune lecture ne passe.

select ok(
  has_function_privilege('authenticated', 'public.is_member(uuid)', 'execute')
  and has_function_privilege('authenticated', 'public.is_admin(uuid)', 'execute')
  and has_function_privilege('authenticated', 'public.is_blocked(uuid)', 'execute')
  and has_function_privilege('authenticated', 'public.is_blocked_in_conversation(uuid)', 'execute')
  and has_function_privilege('authenticated', 'public.can_read_message(uuid)', 'execute'),
  'les helpers RLS restent appelables par authenticated'
);

select ok(
  has_function_privilege('authenticated', 'public.get_or_create_dm(uuid)', 'execute')
  and has_function_privilege('authenticated', 'public.mark_conversation_read(uuid, bigint)', 'execute')
  and has_function_privilege('authenticated', 'public.unread_count(uuid)', 'execute')
  and has_function_privilege('authenticated', 'public.create_group(uuid, text, uuid[], text)', 'execute')
  and has_function_privilege('authenticated', 'public.search_profiles(text, int)', 'execute'),
  'les fonctions applicatives restent appelables par authenticated'
);

-- Les fonctions internes aux triggers de #41 ne sont appelables par personne :
-- `emit_system_message` écrit un message système sans vérifier l'appartenance,
-- et la policy interdit précisément aux clients d'en fabriquer un (#14).
select ok(
  not has_function_privilege('authenticated', 'public.emit_system_message(uuid, uuid, jsonb)', 'execute')
  and not has_function_privilege('anon', 'public.emit_system_message(uuid, uuid, jsonb)', 'execute')
  and not has_function_privilege('authenticated', 'public.system_messages_suppressed()', 'execute'),
  'les rouages des messages système restent internes'
);

-- ---------------------------------------------------------------------------
-- Ce qui est purement interne
-- ---------------------------------------------------------------------------
-- `refresh_conversation_preview` réécrit l'aperçu d'une conversation sans
-- vérifier l'appartenance : elle n'est appelée que depuis un trigger, où le
-- droit d'écrire a déjà été établi. Exposée, elle laisserait n'importe qui
-- toucher la ligne d'une conversation dont il n'est pas membre.

select ok(
  not has_function_privilege('authenticated', 'public.refresh_conversation_preview(uuid)', 'execute')
  and not has_function_privilege('anon', 'public.refresh_conversation_preview(uuid)', 'execute'),
  'refresh_conversation_preview reste interne'
);

select * from finish();
rollback;
