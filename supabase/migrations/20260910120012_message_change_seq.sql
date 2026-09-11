-- Suite de changements par conversation — le curseur de la synchronisation delta
--
-- #53 pose la question et demande de trancher : la synchronisation par `seq`
-- croissant ne rattrape pas un message modifié ou supprimé APRÈS son émission.
-- Son `seq` ne bouge pas — il ne peut pas bouger, c'est l'ordre d'affichage —
-- donc un client dont le curseur l'a déjà dépassé ne le reverra jamais. Une
-- suppression pour tous resterait visible indéfiniment sur l'appareil d'un
-- utilisateur qui était hors ligne au mauvais moment.
--
-- Deux pistes étaient envisagées dans l'issue.
--
-- **Un second curseur sur `updated_at`** — écarté. Un curseur temporel perd des
-- lignes en présence de transactions concurrentes, et il les perd en silence :
-- `now()` renvoie l'heure de DÉBUT de transaction, donc une transaction longue
-- commencée à 10h00 valide à 10h05 une ligne estampillée 10h00. Un client qui a
-- synchronisé à 10h02 a déjà dépassé ce point : la ligne ne lui reviendra
-- jamais. Le bug ne se reproduit pas à la demande et ne laisse aucune trace.
--
-- **Inclure les modifications dans une suite de seq** — retenu, sous la forme
-- d'une suite DISTINCTE. Réutiliser `seq` était exclu deux fois : il est
-- immuable (le trigger de la migration 009 refuse qu'on y touche), et le faire
-- avancer réordonnerait le fil à chaque correction de faute de frappe.
--
-- D'où `change_seq` : un second compteur par conversation, avancé à chaque
-- écriture — insertion, modification, suppression. `seq` ordonne l'affichage,
-- `change_seq` ordonne la synchronisation. Ils sont indépendants.
--
--   - reprise = `where conversation_id = ? and change_seq > ?`, monotone et
--     sans horloge ;
--   - les trous ne gênent pas : un curseur `>` n'a pas besoin d'une suite
--     dense ;
--   - le compteur est distinct de `last_seq`, qui sert au calcul des non-lus
--     (#15). Les confondre ferait grimper le compteur de messages non lus à
--     chaque modification d'un message déjà lu.
--
-- Coût : une colonne, un compteur, un index. La suppression restant logique
-- (ADR-0002), une ligne supprimée continue d'exister et revient donc par le
-- même chemin que les autres — rien de particulier à prévoir pour elle.

alter table public.conversations
  add column last_change_seq bigint not null default 0;

comment on column public.conversations.last_change_seq is
  'Compteur des écritures de la conversation. Distinct de last_seq, qui compte '
  'les messages et sert aux non-lus.';

alter table public.messages
  add column change_seq bigint not null default 0;

comment on column public.messages.change_seq is
  'Rang de la dernière écriture sur ce message. Avance à chaque insertion, '
  'modification ou suppression. C''est le curseur de la synchronisation delta '
  'de #53 — ne pas confondre avec seq, qui est immuable et ordonne l''affichage.';

-- Rattrapage des lignes existantes AVANT la pose du trigger : `seq` est déjà
-- une suite croissante par conversation, il fait un état initial valide.
update public.messages set change_seq = seq;

update public.conversations c
   set last_change_seq = coalesce(
     (select max(m.change_seq) from public.messages m where m.conversation_id = c.id),
     0
   );

create or replace function public.assign_message_change_seq()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  -- Même mécanique que `assign_message_seq` (#10) : l'incrément se fait dans
  -- l'UPDATE, qui verrouille la ligne de la conversation et sérialise les
  -- écrivains concurrents. Un `max(change_seq) + 1` lu séparément attribuerait
  -- la même valeur à deux écritures simultanées, et le curseur d'un client en
  -- sauterait une.
  update public.conversations
     set last_change_seq = last_change_seq + 1
   where id = new.conversation_id
  returning last_change_seq into new.change_seq;

  return new;
end;
$$;

revoke all on function public.assign_message_change_seq() from public, anon, authenticated;

create trigger messages_assign_change_seq
  before insert or update on public.messages
  for each row execute function public.assign_message_change_seq();

-- Le chemin de la synchronisation delta. Sans lui, chaque reprise balaie toute
-- la conversation pour n'en ramener que la fin.
create index messages_conversation_change_seq_idx
  on public.messages (conversation_id, change_seq);

-- La vue expose le compteur : c'est ce qui permet au client de repérer un
-- curseur incohérent — le sien est en avance sur celui du serveur, ce qui
-- n'arrive que si la base a été restaurée depuis une sauvegarde. Il repart
-- alors de zéro plutôt que d'attendre indéfiniment des lignes qui ne viendront
-- pas.
create or replace view public.conversation_overview
with (security_invoker = true)
as
  select c.id,
         c.type,
         c.title,
         c.avatar_url,
         c.owner_id,
         c.community_id,
         c.last_message_at,
         c.last_message_preview,
         c.last_message_sender_id,
         c.last_message_kind,
         c.last_seq,
         m.role,
         m.last_read_seq,
         m.muted_until,
         m.pinned_at,
         m.archived_at,
         greatest(c.last_seq - m.last_read_seq, 0) as unread_count,
         -- Les colonnes ajoutées vont EN FIN de liste : `create or replace
         -- view` refuse de renommer une colonne existante, et insérer au
         -- milieu revient à renommer tout ce qui suit. Le seul autre chemin
         -- serait un `drop view`, qui casserait toute dépendance posée depuis.
         c.last_change_seq,
         c.created_at
    from public.conversations c
    join public.conversation_members m
      on m.conversation_id = c.id
   where m.user_id = (select auth.uid());

revoke all on public.conversation_overview from anon;
grant select on public.conversation_overview to authenticated;
