# ADR-0003 — Pas de chiffrement de bout en bout en V1

- **Statut** : Accepté
- **Date** : 2026-09-09
- **Concerne** : #69, #79, #93

## Contexte

Le chiffrement de bout en bout (E2EE) est devenu l'attente par défaut d'une messagerie,
et à raison. Il protège les conversations d'un opérateur curieux, d'une fuite de base de
données, d'une réquisition administrative.

Mais il ne se rajoute pas : il change le modèle de données en profondeur. Le serveur ne
voit plus que du chiffré, ce qui retire d'un coup la recherche côté serveur, la génération
des aperçus de notification, la sauvegarde transparente et l'ajout simple d'un second
appareil. Chacune de ces pertes demande une reconstruction complète du mécanisme concerné.

La question n'est donc pas « faut-il chiffrer », mais « à quel moment payer ce coût ».

## Décision

**La V1 de Kola n'est pas chiffrée de bout en bout.**

Ce qui est en place en V1 :

- **TLS en transit**, sur toutes les communications.
- **Chiffrement au repos**, assuré par Supabase au niveau du stockage.
- **Row Level Security stricte** en Postgres : l'isolation entre utilisateurs est garantie
  par la base, pas par le code client (#14).

Ce qui n'est pas en place : la protection contre un accès à l'infrastructure elle-même.
Un administrateur Supabase, ou quiconque obtiendrait un accès à la base, peut lire les
messages.

**L'E2EE est prévu en V3, via MLS** (RFC 9420), après le spike #93 qui doit en mesurer le
coût réel avant tout engagement.

### Règle contraignante sur la communication

Tant que l'E2EE n'existe pas, **il est interdit d'écrire ou de laisser entendre que Kola
est chiffrée de bout en bout**. Cela vaut pour :

- l'interface de l'application, y compris les écrans d'onboarding ;
- les fiches App Store et Google Play, et la déclaration de chiffrement d'Apple (#79) ;
- la politique de confidentialité et les CGU (#69) ;
- toute communication publique ou commerciale.

La formulation exacte autorisée est : **« chiffré en transit et au repos »**. Écrire
« chiffré » sans qualificatif est trompeur, parce que le lecteur comprendra « de bout en
bout ». Ce n'est pas une précaution juridique : c'est une question de ne pas mentir à des
gens qui prendront des décisions sur la foi de cette phrase.

## Alternatives écartées

**E2EE dès la V1.** Écartée parce qu'elle repousserait la V1 de plusieurs mois et
bloquerait des fonctionnalités attendues dès le premier jour : recherche dans l'historique
(#36), aperçu dans les notifications (#58), multi-appareils (#24). Livrer une messagerie
utilisable est le préalable à tout le reste.

**Signal Protocol plutôt que MLS.** Éprouvé, largement déployé, bien documenté. Écarté pour
la V3 au profit de MLS parce que son passage à l'échelle en groupe est linéaire (chaque
changement de membre coûte proportionnellement au nombre de participants) alors que MLS est
logarithmique — un écart qui compte pour des groupes de plusieurs centaines de membres, un
usage courant sur ce marché. À reconfirmer par le spike #93.

**Chiffrement optionnel, activable par conversation.** Écarté parce qu'un chiffrement
optionnel n'est presque jamais activé, et qu'il donne l'illusion d'une protection générale
tout en doublant la complexité du code de synchronisation.

## Conséquences

**Ce que cela rend possible en V1.** Recherche plein texte, aperçus de notification,
sauvegarde et restauration simples, ajout d'un appareil sans transfert de clés, modération
effective du contenu signalé (#66) — cette dernière étant une exigence formelle de l'App
Store.

**Ce que cela laisse exposé.** Un accès à l'infrastructure Supabase donne accès au contenu
des messages. C'est le risque assumé, et il doit être énoncé tel quel dans la politique de
confidentialité, sans enrobage.

**Ce que cela impose plus tard.** La migration vers l'E2EE devra traiter une base existante
de messages en clair, avec une période où les deux modes coexistent. Ce coût est déjà
identifié et fait partie du périmètre du spike #93. Il faudra aussi trancher une question
qui n'est pas technique : sans sauvegarde de clés, perdre son téléphone signifie perdre
tout son historique.

**Mesures compensatoires en V1**, qui ne remplacent pas l'E2EE mais réduisent la surface :
RLS auditée avant l'ouverture au public (#70), aucun carnet d'adresses stocké en clair
(#68), et suppression de compte réellement effective (#25).
