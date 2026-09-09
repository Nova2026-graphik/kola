# ADR-0002 — Architecture local-first

- **Statut** : Accepté
- **Date** : 2026-09-09
- **Concerne** : #27, #28, #32, #53, #54

## Contexte

Au Togo, le réseau mobile n'est ni continu ni gratuit. Une connexion tombe en pleine
conversation, revient dix minutes plus tard, puis disparaît pour la journée. Les données
se comptent en centaines de mégaoctets par mois et se rechargent par crédit.

Une messagerie conçue comme un client d'API se comporte mal dans ces conditions : écrans
vides en attendant la réponse, indicateurs de chargement permanents, messages perdus au
moment de l'envoi, historique rechargé à chaque reconnexion. Ce n'est pas une question de
finition — c'est une application inutilisable la moitié du temps.

## Décision

**SQLite est la source de vérité de l'application. Le réseau est un bonus, pas un
prérequis.**

Quatre règles en découlent, et elles ne souffrent pas d'exception :

1. **L'interface ne lit jamais le réseau.** Elle lit SQLite. Tout écran qui appelle
   directement Supabase est un bug d'architecture, pas un raccourci. La règle est
   appliquée par ESLint (`no-restricted-imports` sur `apps/mobile/app/`), pas seulement
   par la revue.

2. **Toute écriture va d'abord en base locale**, avec le statut `pending`, puis dans une
   file d'attente sortante persistante (_outbox_) qui pousse vers le serveur avec une
   temporisation exponentielle. L'insertion locale et la mise en file sont **atomiques** :
   une insertion réussie sans mise en file produirait un message qui ne partirait jamais,
   sans que rien ne le signale.

3. **Chaque message porte un `client_id`**, un UUID v4 généré sur l'appareil et marqué
   unique en base. Un renvoi après expiration de délai est donc rejeté par la contrainte
   d'unicité plutôt que dupliqué. C'est ce qui autorise l'outbox à réessayer sans compter.

4. **La synchronisation se fait par curseur.** Chaque conversation porte un compteur `seq`
   monotone attribué par un trigger Postgres. Le client conserve le dernier `seq` connu ;
   la reprise après coupure est un `where seq > curseur`, jamais un rechargement complet.
   Le volume transféré est proportionnel à ce qui manque, pas à la taille de l'historique.

Corollaire assumé : **la suppression d'un message est toujours logique** (`deleted_at`),
jamais physique. Un `DELETE` créerait un trou dans la suite des `seq` et casserait la
reprise des clients hors ligne depuis longtemps.

## Alternatives écartées

**Client d'API avec cache.** L'approche par défaut : TanStack Query, cache mémoire, requêtes
au montage. Écartée parce que le cache y est une optimisation, pas une garantie — il est
vidé, il expire, et l'application redevient inutilisable. La différence est visible dès le
premier trajet sans réseau.

**Réplication complète type CRDT.** Techniquement séduisante, et elle résoudrait aussi la
fusion des modifications concurrentes. Écartée sur le coût : les métadonnées CRDT pèsent
lourd sur des appareils à 2 Go, la mise au point est longue, et le problème qu'elle résout
— l'édition concurrente du même contenu — ne se pose presque pas en messagerie, où chaque
message a un auteur unique.

**Synchronisation par horodatage** plutôt que par compteur. Écartée parce que les horloges
des appareils dérivent, sont réglées à la main, et sautent au changement de fuseau. Un
compteur monotone attribué par le serveur ne ment pas.

## Conséquences

**Ce que cela rend facile.** L'application est pleinement utilisable en mode avion :
lecture de tout l'historique, rédaction, mise en file. Un message envoyé s'affiche
instantanément. La reconnexion après trois jours coûte quelques kilooctets. La recherche
plein texte fonctionne hors ligne (#36).

**Ce que cela rend difficile.** Deux schémas à maintenir en miroir, local et serveur, qui
peuvent diverger. Les migrations locales s'exécutent sur l'appareil d'un utilisateur, sans
possibilité de retour arrière : elles doivent être strictement additives. Et l'outbox est
le composant le plus délicat du produit — ses bugs n'apparaissent qu'après une coupure au
mauvais moment, chez un utilisateur, sans trace exploitable. D'où l'exigence de couverture
de tests de 90 % qui pèse sur lui (#71).

**Ce que cela interdit.** Aucun écran ne peut afficher une donnée qui n'est pas passée par
SQLite. Y compris les événements temps réel : un message reçu par Realtime est écrit en
base, puis lu par l'interface. Jamais l'inverse.

**Le point de vigilance principal** est l'avancement du curseur de synchronisation :
l'avancer avant d'avoir écrit localement fait perdre des messages définitivement. Écriture
puis avancement, dans une même transaction.
