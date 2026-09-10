-- Correctif de typage — `messages.seq` doit être omissible à l'insertion
--
-- `seq` est `not null` sans valeur par défaut, et c'est le trigger
-- `assign_message_seq` (#10) qui l'attribue en `before insert`.
--
-- Le générateur de types TypeScript (#16) ne connaît pas les triggers : il
-- lit le schéma et conclut que `seq` est obligatoire à l'insertion. Le client
-- ne peut donc pas insérer un message sans inventer une valeur — que le
-- trigger écraserait aussitôt.
--
-- Écrire un cast dans le client pour contourner le type serait la mauvaise
-- réponse : cela masquerait l'incohérence au lieu de la lever, et le prochain
-- développeur perdrait le même temps.
--
-- La valeur par défaut n'est jamais utilisée en pratique — le trigger
-- s'exécute avant l'insertion et écrase toujours `new.seq`. Elle sert
-- uniquement à dire au schéma ce qui est déjà vrai : la valeur vient de la
-- base, pas du client.

alter table public.messages
  alter column seq set default 0;

comment on column public.messages.seq is
  'Attribué par le trigger assign_message_seq, sous verrou de ligne. La valeur '
  'par défaut n''est jamais retenue : elle rend seulement la colonne omissible '
  'à l''insertion, ce que les types générés doivent refléter.';
