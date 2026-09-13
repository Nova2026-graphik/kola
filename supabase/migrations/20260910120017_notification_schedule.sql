-- Déclenchement périodique de l'envoi des notifications (#58)
--
-- La file regroupe par fenêtre de silence : une rafale de messages n'est
-- notifiée qu'une fois calmée. Il faut donc quelque chose qui revienne voir, et
-- ce quelque chose ne peut pas être le trigger d'insertion.
--
-- Le raisonnement mérite d'être écrit, parce que la solution évidente est
-- fausse. Si c'était le trigger qui appelait la fonction Edge, l'appel aurait
-- lieu à l'instant de l'écriture, trouverait la fenêtre non écoulée, et
-- repartirait sans rien envoyer. Le dernier message d'une rafale — précisément
-- celui qui doit déclencher la notification — ne serait jamais suivi d'un autre
-- appel. Personne ne serait notifié de rien.
--
-- D'où un minuteur. `pg_cron` repasse toutes les dix secondes et `pg_net` poste
-- vers la fonction Edge sans bloquer la transaction.

create extension if not exists pg_cron with schema extensions;
create extension if not exists pg_net  with schema extensions;

-- ---------------------------------------------------------------------------
-- Les identifiants de l'appel vivent dans Vault
-- ---------------------------------------------------------------------------
-- La clé de service contourne RLS : elle n'a rien à faire dans une migration
-- versionnée, ni dans une colonne lisible. Vault la chiffre au repos et seule
-- une fonction SECURITY DEFINER la relit.
--
-- Les deux secrets doivent être créés à la main, une fois par projet :
--
--   select vault.create_secret('https://<ref>.supabase.co', 'project_url');
--   select vault.create_secret('<clé de service>',          'service_role_key');
--
-- Voir docs/livraison.md.

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

  perform extensions.http_post(
    url     := url || '/functions/v1/notify',
    headers := jsonb_build_object(
      'Content-Type',  'application/json',
      'Authorization', 'Bearer ' || cle
    ),
    body    := '{}'::jsonb,
    -- L'appel ne doit pas retenir le minuteur : la fonction Edge peut mettre
    -- plusieurs secondes à répondre quand Expo est lent.
    timeout_milliseconds := 5000
  );
end;
$$;

revoke all on function public.dispatch_notifications() from public, anon, authenticated;

comment on function public.dispatch_notifications() is
  'Appelle la fonction Edge notify. Ne fait rien tant que les secrets Vault ne '
  'sont pas posés, plutôt que d''échouer toutes les dix secondes (#58).';

-- ---------------------------------------------------------------------------
-- Le minuteur
-- ---------------------------------------------------------------------------
-- Dix secondes : la même valeur que la fenêtre de regroupement. Plus court
-- ferait tourner le minuteur pour rien ; plus long ajouterait au délai déjà
-- accepté pour le regroupement, et une messagerie où la notification arrive
-- trente secondes après le message ne sert plus à grand-chose.

select cron.schedule(
  'kola-notifications',
  '10 seconds',
  $$ select public.dispatch_notifications() $$
);
