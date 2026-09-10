-- Correctif — la suppression logique était bloquée par la fenêtre de modification
--
-- Défaut introduit par 20260910120007_rls_policies.sql.
--
-- `enforce_message_edit_window` refusait toute modification de `body` au-delà
-- de quinze minutes. Or une suppression logique met précisément `body` à NULL :
-- le trigger la lisait donc comme une édition tardive et la rejetait.
--
-- Conséquence : **il était impossible de supprimer un message de plus de quinze
-- minutes**, ce qui vide de son sens la suppression pour tous (#34) et prive la
-- modération de son principal levier (#66).
--
-- Trouvé par le script de seed (#17), qui supprime un message vieux de vingt
-- heures — un cas qu'aucun des tests de #14 ne couvrait.
--
-- La correction distingue les deux opérations : une suppression n'est pas une
-- édition, et n'a pas de raison d'être limitée dans le temps.

create or replace function public.enforce_message_edit_window()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  edit_window constant interval := interval '15 minutes';
  is_deletion  boolean;
begin
  -- Passage de « vivant » à « supprimé », dans cette transaction.
  is_deletion := new.deleted_at is not null and old.deleted_at is null;

  if is_deletion then
    -- Une suppression met `body` à NULL : c'est attendu, et elle reste possible
    -- sans limite de temps. Seul le contenu doit disparaître, rien d'autre.
    if new.body is not null then
      raise exception 'la suppression doit vider le corps du message'
        using errcode = 'check_violation';
    end if;

  elsif new.body is distinct from old.body then
    -- Vraie édition.
    if old.deleted_at is not null then
      raise exception 'un message supprimé ne se modifie plus'
        using errcode = 'check_violation';
    end if;

    if old.created_at < now() - edit_window then
      raise exception 'la fenêtre de modification est dépassée'
        using errcode = 'check_violation';
    end if;

    new.edited_at := now();
  end if;

  -- Une suppression ne se défait pas : sinon un message effacé chez tous les
  -- participants pourrait réapparaître.
  if old.deleted_at is not null and new.deleted_at is null then
    raise exception 'un message supprimé ne peut pas être restauré'
      using errcode = 'check_violation';
  end if;

  -- Invariants de synchronisation : inchangés.
  if new.seq is distinct from old.seq
     or new.conversation_id is distinct from old.conversation_id
     or new.client_id is distinct from old.client_id
     or new.sender_id is distinct from old.sender_id
     or new.created_at is distinct from old.created_at then
    raise exception 'champ immuable modifié sur un message'
      using errcode = 'check_violation';
  end if;

  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- Second volet du même défaut : la contrainte de corps obligatoire
-- ---------------------------------------------------------------------------
--
-- `messages_body_required`, posée par 20260910120003_messages.sql, exige un
-- corps non vide pour les messages `text` et `system`. Elle ne prévoyait pas
-- la suppression logique, qui vide précisément ce corps.
--
-- Les deux garde-fous se contredisaient donc : l'un imposait un corps, l'autre
-- exigeait de l'effacer. La suppression pour tous était impossible quel que
-- soit le délai.
--
-- Pourquoi les tests de #14 ne l'ont pas vu : ils marquaient `deleted_at` sans
-- toucher au corps, alors que le chemin réel du repository (#28) met les deux à
-- jour ensemble. Le test reproduisait une suppression qui n'existe pas.

alter table public.messages
  drop constraint messages_body_required;

alter table public.messages
  add constraint messages_body_required
  check (
    -- Un message supprimé n'a plus de corps, par construction.
    deleted_at is not null
    or kind not in ('text', 'system')
    or (body is not null and length(btrim(body)) > 0)
  );
