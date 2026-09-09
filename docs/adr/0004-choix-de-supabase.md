# ADR-0004 — Choix de Supabase

- **Statut** : Accepté
- **Date** : 2026-09-09
- **Concerne** : #7, #13, #14, #70

## Contexte

Kola a besoin d'une base de données, d'une authentification par OTP SMS et e-mail, d'un
canal temps réel, d'un stockage de fichiers et d'un moyen d'exécuter du code serveur pour
les notifications et la modération.

Une équipe de deux à cinq personnes ne peut pas construire et exploiter tout cela avant
d'avoir envoyé son premier message. La question est donc : quel service assemble ces
briques sans nous enfermer.

## Décision

**Supabase**, avec Postgres comme socle : Auth, Realtime, Storage et Edge Functions.

Trois conséquences directes structurent le code :

1. **Toute la sécurité d'accès est en Row Level Security**, dans la base, pas dans le
   client. C'est ce qui permet à l'application mobile de parler directement à Postgres
   sans couche d'API intermédiaire à écrire et à maintenir. Aucune table du schéma
   `public` sans RLS activée.

2. **Les policies passent par des fonctions `SECURITY DEFINER`** (`is_member`,
   `is_admin`, `is_blocked`) pour éviter la récursion RLS — une policy sur `messages` qui
   interroge `conversation_members`, elle-même protégée par une policy qui interroge
   `messages`, est rejetée par Postgres. Ces fonctions ont un `search_path` fixé à vide et
   qualifient tous les noms de table : sans cela, elles constituent une faille d'élévation
   de privilèges connue.

3. **La clé `service_role` ne quitte jamais le serveur.** Elle vit exclusivement dans les
   secrets des Edge Functions. Toute opération privilégiée — suppression de compte,
   révocation de session, envoi de notification — passe par une fonction, jamais par le
   client.

## Alternatives écartées

**Firebase.** L'offre la plus complète et la plus éprouvée sur mobile. Écartée sur deux
points : Firestore est un magasin de documents, mal adapté à un modèle relationnel avec
compteurs monotones et contraintes d'unicité — or `client_id` unique et `seq` par
conversation sont au cœur de l'[ADR-0002](0002-architecture-local-first.md) ; et sa
tarification à l'opération devient imprévisible avec une synchronisation intensive.

**Appwrite.** Auto-hébergeable, ce qui est un vrai atout. Écarté sur la maturité du temps
réel et de l'écosystème d'outils par rapport à Supabase, à équipe réduite.

**Backend maison.** Écarté dans l'[ADR-0001](0001-choix-de-la-stack.md) : plusieurs mois
avant le premier message envoyé.

**PocketBase.** Léger, agréable, un seul binaire. Écarté sur le passage à l'échelle et sur
l'absence d'équivalent aux Edge Functions.

## Conséquences

**Ce que cela rend facile.** Postgres avec ses contraintes, ses triggers et ses index —
exactement ce dont le modèle de données a besoin. Une authentification OTP prête. Un temps
réel branché sur la réplication de la base. Des types TypeScript générés depuis le schéma
(#16), donc une colonne renommée casse la compilation plutôt que la production.

**Ce que cela rend difficile.** Le débogage des policies RLS est ingrat : une policy peut
sembler correcte et se comporter autrement, d'où l'obligation de tests pgTAP (#72) plutôt
qu'une relecture. Les performances des policies comptent aussi — une fonction non `STABLE`
appelée dans une policy est réévaluée à chaque ligne, ce qui se voit sur une page de
cinquante messages.

**Le risque d'enfermement** est réel mais borné, et voici la sortie envisagée :

- Le cœur est du **Postgres standard**. Migrations SQL versionnées, triggers, RLS : tout
  cela fonctionne sur n'importe quel Postgres. `supabase db dump` produit un dump
  utilisable ailleurs.
- **Auth** est la partie la plus spécifique. Une sortie impliquerait de réimplémenter
  l'OTP et la gestion de session ; les identités restent récupérables depuis `auth.users`.
- **Realtime** est remplaçable, car l'[ADR-0002](0002-architecture-local-first.md) en fait
  déjà une simple optimisation de latence : la synchronisation par curseur reste la source
  de vérité, et l'application resterait fonctionnelle sans temps réel.
- **Storage** expose une API compatible S3.

Autrement dit, la dépendance forte se limite à Auth. C'est un coût acceptable au regard du
temps gagné.

**Contrainte d'exploitation** : les projets Supabase du plan gratuit se mettent en pause
après une semaine d'inactivité. Sans importance en développement, à surveiller pour
`staging`.
