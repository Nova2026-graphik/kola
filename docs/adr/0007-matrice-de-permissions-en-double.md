# ADR-0007 — La matrice de permissions existe en double, et c'est assumé

- **Statut** : Accepté
- **Date** : 2026-09-10
- **Concerne** : #14, #38, #39, #84

## Contexte

Un groupe Kola a trois rôles — propriétaire, administrateur, membre — et une dizaine
d'actions dont la disponibilité en dépend. Deux besoins tirent dans des directions
opposées.

Le serveur doit **appliquer** la règle. C'est la seule chose qui compte : une vérification
côté interface n'est qu'un confort, et le critère d'acceptation de #39 le dit mot pour mot
— « y compris par appel direct à l'API ».

L'interface doit **connaître** la règle. Un écran qui propose « Retirer ce membre » à
quelqu'un qui n'en a pas le droit produit un échec incompréhensible, et sur un réseau lent
l'utilisateur attend plusieurs secondes avant de l'apprendre.

Or PostgreSQL ne lit pas le TypeScript, et le TypeScript ne peut pas interroger la base
pendant un rendu hors ligne. #39 demandait que la matrice « existe en un seul endroit,
partagé entre le client et le serveur via `packages/core`, sinon les deux dérivent ».
L'intention est juste ; la lettre est irréalisable.

## Décision

**La matrice existe en deux exemplaires, et un test compare les deux.**

- `packages/core/src/permissions.ts` porte la matrice pour l'interface, sous forme de
  données. C'est elle que lit chaque écran.
- La migration `20260910120015` porte la même matrice sous forme de lignes dans
  `public.role_permissions`, encadrée par deux marqueurs de commentaire.
- `packages/core/src/permissions.sql.test.ts` lit le fichier de migration, extrait le bloc
  entre les marqueurs, et le compare rôle par rôle à la matrice TypeScript.

Les policies et les triggers n'écrivent jamais la règle en dur : ils appellent
`has_permission(conversation_id, permission)`, qui lit la table. Une permission ajoutée
demain ne demande donc pas de revoir dix policies.

### Les deux règles que la matrice tranche

**Changer un rôle est réservé au propriétaire**, pas aux administrateurs. Un administrateur
qui peut en nommer d'autres peut aussi les rétrograder : à trois administrateurs, le groupe
se prend un jeu de chaises musicales et le propriétaire n'a aucun recours. C'est un
durcissement par rapport à #14.

**Le propriétaire ne peut pas quitter le groupe sans transférer la propriété.** #39
demandait de trancher explicitement le cas du départ du propriétaire. L'alternative —
promouvoir automatiquement le plus ancien administrateur — confierait un groupe à quelqu'un
qui ne l'a pas demandé et sans qu'il le sache. Le départ est donc bloqué, et un groupe ne se
retrouve jamais sans propriétaire.

## Conséquences

**Ce qu'on gagne.** La dérive devient une erreur de test, c'est-à-dire l'endroit où elle
coûte le moins. Un contributeur qui ajoute une permission côté serveur sans la déclarer
côté client — ou l'inverse — le sait à la seconde suivante, pas six mois plus tard en
production.

**Ce qu'on paie.** Deux fichiers à modifier ensemble, et un test qui dépend d'un chemin de
fichier et de deux marqueurs de commentaire. Retirer les marqueurs désarmerait le test : il
lève une exception explicite plutôt que de passer silencieusement sur un ensemble vide, et
un premier contrôle vérifie qu'il a bien extrait trois rôles.

**Ce qu'on n'a pas fait.** Générer le SQL depuis le TypeScript aurait supprimé la seconde
copie, mais les migrations sont immuables une fois appliquées : un générateur produirait un
fichier qu'on ne peut plus régénérer, ce qui déplace le problème sans le résoudre. Lire la
table depuis le client à chaque rendu était exclu par le local-first (ADR-0002) : l'écran
d'infos doit s'ouvrir sans réseau.

**Ce que cela prépare.** Les permissions granulaires des communautés (#84, jalon M12) se
grefferont sur `has_permission` et sur la même table, sans toucher aux policies existantes.
