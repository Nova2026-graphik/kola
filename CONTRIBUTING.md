# Contribuer à Kola

## Charte de branches

| Branche            | Rôle                                                       |
| ------------------ | ---------------------------------------------------------- |
| `main`             | Production. Une release égale un tag sur cette branche.    |
| `develop`          | Intégration. Toutes les fonctionnalités y sont fusionnées. |
| `feat/<n°>-<slug>` | Une branche par issue, fusionnée dans `develop` par PR.    |

Le numéro est celui de l'issue GitHub, le slug une forme courte de son titre :

```bash
git checkout develop && git pull
git checkout -b feat/29-liste-conversations
```

**On ne pousse jamais directement sur `main` ni sur `develop`.** La protection de branche
n'est pas activable sur un dépôt privé en plan GitHub gratuit
([ADR-0005](docs/adr/0005-strategie-de-release.md)) : la règle tient donc par convention,
et la CI sert de garde-fou.

## Format des commits

Conventional Commits, vérifié par un hook Git et par la CI. Ce n'est pas cosmétique : ces
messages alimentent la génération du CHANGELOG et des notes de version.

```
<type>(<portée>): <sujet à l'impératif, sans point final>

<corps facultatif : pourquoi, pas comment>

Refs #<numéro d'issue>
```

**Types autorisés** : `feat`, `fix`, `chore`, `docs`, `refactor`, `perf`, `test`, `build`,
`ci`, `revert`.

**Portées autorisées** : `mobile`, `core`, `api`, `ui`, `db`, `ci`, `docs`, `deps`,
`release`. La portée est facultative — certains changements sont transverses.

```
feat(mobile): affiche l'état d'envoi dans la bulle de message
fix(db): corrige la collision de seq sous écritures concurrentes
docs: rédige les ADR 0001 à 0006
```

Un commit qui décrit _ce que_ fait le diff n'apporte rien : le diff le dit déjà. Le corps
du message sert à expliquer **pourquoi**, et ce qui a été écarté.

## Cycle de vie d'une PR

1. **Une issue par unité de travail.** Si le travail n'a pas d'issue, en ouvrir une avant.
2. **Une branche par issue**, depuis `develop`.
3. **Implémenter, avec les tests.** La charte du projet interdit de livrer du code non
   testé — c'est particulièrement vrai pour l'outbox et le moteur de synchronisation, dont
   les bugs ne se reproduisent pas facilement.
4. **Ouvrir la PR vers `develop`**, avec `Closes #<numéro>` dans le corps.
5. **Attendre que la CI passe.** Une PR rouge ne se fusionne pas.
6. **Fusionner en squash.** La branche est supprimée automatiquement.
7. **Fermer l'issue à la main.** GitHub ne ferme automatiquement une issue qu'au merge dans
   la branche par défaut ; nos PR visent `develop`. Le mot-clé `Closes` reste dans le corps
   pour la traçabilité.
8. **Mettre à jour le CHANGELOG** dans la section « Non publié ».

## Avant d'ouvrir une PR

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm format:check
```

C'est exactement ce que la CI exécute. Les lancer localement évite un aller-retour.

## Proposer un changement d'architecture

Si vous pensez qu'une meilleure approche existe que celle décrite dans un ADR ou dans une
issue : **ouvrez une issue `type:spike` avant d'implémenter**. Ne déviez pas seul.

Une décision structurante qui est adoptée donne lieu à un nouvel ADR dans `docs/adr/`. Un
ADR ne se réécrit pas : il se remplace par un nouveau qui le supersède.

## Règles non négociables

- **Aucun secret en dur.** Tout passe par les variables d'environnement et les secrets EAS.
  Une clé committée est une clé compromise, même après suppression du commit.
- **Aucune table sans RLS.** La sécurité d'accès est dans la base, pas dans le client.
- **L'interface ne lit jamais le réseau.** Elle lit SQLite. La règle est appliquée par
  ESLint sur `apps/mobile/app/`.
- **Ne jamais écrire que Kola est chiffrée de bout en bout**, tant qu'elle ne l'est pas.
  La formulation autorisée est « chiffré en transit et au repos »
  ([ADR-0003](docs/adr/0003-pas-de-e2ee-en-v1.md)).
- **Pas de code non testé sur `main`.**

## Style

Le style est imposé par ESLint et Prettier, appliqués automatiquement au commit. Il ne se
discute pas en revue : si une règle gêne, on change la règle, pas le fichier.

L'interface et les commentaires sont en français. Le code — noms de variables, de fonctions,
de types — est en anglais, comme les bibliothèques sur lesquelles il s'appuie.
