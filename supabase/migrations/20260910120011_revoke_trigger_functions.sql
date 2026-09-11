-- Révocation d'EXECUTE sur les fonctions de trigger
--
-- Les advisors Supabase signalent huit fonctions SECURITY DEFINER exécutables
-- par `anon` via `/rest/v1/rpc/...`. Ce sont toutes des fonctions de trigger,
-- exposées par le `ALTER DEFAULT PRIVILEGES` que Supabase pose sur le schéma
-- public (voir la migration 20260910120007).
--
-- Elles ne sont pas appelables : PostgreSQL refuse avec
--
--     0A000 : trigger functions can only be called as triggers
--
-- vérifié sur le serveur avant d'écrire cette migration. Le garde-fou de la
-- migration 007 les excluait donc délibérément.
--
-- On les révoque quand même, pour une raison qui n'est pas la sécurité
-- immédiate mais la lisibilité du signal : un rapport d'advisors qui contient
-- huit avertissements permanents et inoffensifs est un rapport que personne ne
-- lit. Le neuvième, celui qui comptera, passerait inaperçu.
--
-- Le garde-fou est repris ici sans l'exclusion des triggers : désormais AUCUNE
-- fonction SECURITY DEFINER du schéma public n'est exécutable par `anon`, et
-- la règle n'a plus d'exception à retenir.

revoke all on function public.assign_message_seq()              from public, anon, authenticated;
revoke all on function public.enforce_dm_member_limit()         from public, anon, authenticated;
revoke all on function public.enforce_media_has_attachment()    from public, anon, authenticated;
revoke all on function public.enforce_member_role_change()      from public, anon, authenticated;
revoke all on function public.enforce_message_edit_window()     from public, anon, authenticated;
revoke all on function public.enforce_reply_same_conversation() from public, anon, authenticated;
revoke all on function public.handle_new_user()                 from public, anon, authenticated;
revoke all on function public.on_message_written()              from public, anon, authenticated;

-- Les triggers continuent de s'exécuter : ils tournent sous le propriétaire de
-- la table, pas sous le rôle appelant. Révoquer EXECUTE ne les désarme pas.

-- ---------------------------------------------------------------------------
-- Garde-fou renforcé : plus aucune exception
-- ---------------------------------------------------------------------------

do $$
declare
  exposed text;
begin
  select string_agg(p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')',
                    ', ' order by p.proname) into exposed
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and p.prosecdef
     and p.prokind = 'f'
     and has_function_privilege('anon', p.oid, 'execute');

  if exposed is not null then
    raise exception
      'fonctions SECURITY DEFINER exécutables par anon : %. Ajouter « revoke all on function ... from public, anon; »',
      exposed;
  end if;
end;
$$;
