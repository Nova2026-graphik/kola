# ADR-0005 — Stratégie de release

- **Statut** : Accepté
- **Date** : 2026-09-09
- **Concerne** : #75, #78, #80

## Contexte

Une mise à jour depuis un store coûte des données à l'utilisateur — plusieurs dizaines de
mégaoctets, sur un forfait qui en compte quelques centaines par mois. Beaucoup
d'utilisateurs désactivent les mises à jour automatiques pour cette raison précise, ce qui
signifie qu'une part du parc restera durablement sur une version ancienne.

Par ailleurs, la revue de l'App Store prend de un à plusieurs jours. Un bug bloquant
découvert un vendredi resterait en production tout le week-end.

## Décision

### Branches

- `main` : ce qui est en production. Une release égale un tag sur `main`.
- `develop` : branche d'intégration. Toutes les fonctionnalités y sont fusionnées.
- `feat/<numéro>-<slug>` : une branche par issue, fusionnée dans `develop` par PR.

Une PR ferme son issue via `Closes #N`. Attention : GitHub ne ferme automatiquement une
issue qu'au merge dans la branche **par défaut**. Nos PR visant `develop`, la fermeture se
fait à la main au merge ; le mot-clé reste pour la traçabilité.

### Versionnement

Versionnement sémantique sur la version applicative (`0.1.0`). Le numéro de build est
incrémenté automatiquement par EAS et n'a pas de signification produit.

### Canaux de livraison

| Canal         | Contenu                 | Public         | Déclencheur         |
| ------------- | ----------------------- | -------------- | ------------------- |
| `development` | Client de développement | Développeurs   | À la demande        |
| `preview`     | APK direct / TestFlight | Équipe interne | Fin de chaque jalon |
| `production`  | AAB signé / App Store   | Public         | Tag sur `main`      |

### Mises à jour à distance (EAS Update)

Le correctif JavaScript livré hors store est le levier principal de cette stratégie. Trois
règles l'encadrent :

1. **Jamais de téléchargement automatique hors Wi-Fi sans consentement.** Ce serait
   contredire frontalement la politique d'économie de données (#49, #56).
2. **Une mise à jour à distance ne modifie pas le code natif.** Ajouter un module natif
   impose un build de store. Le dire clairement évite des attentes fausses.
3. **Pas de changement substantiel de fonctionnalité par cette voie.** Les deux stores
   l'interdisent, sous peine de retrait.

### Retour arrière

Le retour arrière d'une mise à jour à distance se fait en une commande, en republiant la
version précédente sur le canal. C'est la voie normale de correction d'un incident.

Un binaire défectueux déjà publié sur un store ne se retire pas : il se remplace par une
version corrective, avec le délai de revue correspondant. D'où la règle : **tout ce qui
peut être corrigé à distance doit l'être**.

## Alternatives écartées

**Trunk-based development** avec `main` unique et drapeaux de fonctionnalité. Approche
saine, mais elle suppose une CI et une couverture de tests que le projet n'a pas encore.
À reconsidérer une fois le jalon M10 atteint.

**GitFlow complet**, avec branches `release/*` et `hotfix/*`. Écarté comme trop lourd pour
une équipe de deux à cinq personnes : la cérémonie coûterait plus qu'elle ne protège.

**Livraison continue vers les stores** à chaque merge dans `develop`. Écartée à cause du
délai de revue et des quotas de build : le rythme de fusion est plus rapide que le rythme
de revue.

## Conséquences

**Ce que cela rend facile.** Un correctif JavaScript en minutes plutôt qu'en jours. Un
build de prévisualisation testable par l'équipe à chaque fin de jalon. Un historique où
chaque version publiée correspond exactement à un état du dépôt.

**Ce que cela rend difficile.** Deux chemins de livraison à garder cohérents : la version
native installée et la version JavaScript appliquée par-dessus. Une mise à jour incompatible
avec le binaire ne doit jamais être appliquée, ce qui demande une discipline de
versionnement du runtime.

**Contrainte connue** : la protection de branche est indisponible sur un dépôt privé en plan
GitHub gratuit. En attendant un passage à GitHub Pro, la charte de branches est appliquée
par convention, la CI servant de garde-fou effectif.
