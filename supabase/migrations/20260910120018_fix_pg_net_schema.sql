-- Correctif : pg_net vit dans le schéma `net`, pas `extensions`
--
-- La migration précédente appelait `extensions.http_post`. La fonction n'existe
-- pas sous ce nom : `create extension pg_net with schema extensions` installe le
-- support de l'extension, mais ses fonctions restent dans le schéma `net`.
--
-- Ce défaut avait une propriété désagréable : `create or replace function` ne
-- valide pas le corps d'une fonction plpgsql à la création. La migration
-- passait donc sans broncher, et l'erreur ne serait apparue qu'à la première
-- exécution réelle — c'est-à-dire une fois les secrets Vault posés, au moment
-- précis où l'on croit avoir terminé et où l'on cesse de regarder.
--
-- Trouvé en interrogeant `pg_proc` plutôt qu'en se fiant à la réussite de la
-- migration. La leçon vaut au-delà de ce cas : sur du plpgsql, « la migration
-- est passée » ne dit rien de plus que « la syntaxe est correcte ».
--
-- La signature exacte, également vérifiée plutôt que supposée :
--
--   net.http_post(url text, body jsonb, params jsonb, headers jsonb,
--                 timeout_milliseconds integer)

create or replace function public.dispatch_notifications()
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  url text;
  cle text;
begin
  select decrypted_secret into url
    from vault.decrypted_secrets where name = 'project_url';
  select decrypted_secret into cle
    from vault.decrypted_secrets where name = 'service_role_key';

  -- Tant que les secrets ne sont pas posés, on ne fait rien plutôt que d'échouer
  -- toutes les dix secondes. Un journal saturé d'erreurs attendues est un
  -- journal que personne ne lit, et la vraie panne s'y noierait.
  if url is null or cle is null then
    return;
  end if;

  perform net.http_post(
    url     := url || '/functions/v1/notify',
    body    := '{}'::jsonb,
    headers := jsonb_build_object(
      'Content-Type',  'application/json',
      'Authorization', 'Bearer ' || cle
    ),
    -- L'appel ne doit pas retenir le minuteur : la fonction Edge peut mettre
    -- plusieurs secondes à répondre quand Expo est lent.
    timeout_milliseconds := 5000
  );
end;
$$;

revoke all on function public.dispatch_notifications() from public, anon, authenticated;

-- Garde-fou : la fonction appelée doit exister, et sous ce schéma-là. Écrit en
-- migration parce que c'est exactement l'erreur que la migration précédente a
-- laissée passer.
do $$
begin
  if not exists (
    select 1 from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'net' and p.proname = 'http_post'
  ) then
    raise exception 'net.http_post introuvable : pg_net n''est pas installé comme attendu';
  end if;
end;
$$;
