# Kola

Messagerie panafricaine — la messagerie personnelle de WhatsApp, les communautés de Discord,
les canaux de Telegram, pensés pour les réseaux d'Afrique de l'Ouest. Premier marché : le Togo.

> ⚠️ Kola n'est **pas** chiffrée de bout en bout. Les messages sont chiffrés en transit et
> au repos, et isolés par Row Level Security, mais un accès à l'infrastructure donne accès
> à leur contenu. C'est une décision assumée et documentée :
> [ADR-0003](docs/adr/0003-pas-de-e2ee-en-v1.md).

## Le principe directeur

**Local-first.** SQLite est la source de vérité de l'application, pas le serveur. Tout
l'historique est lisible hors ligne, les messages se rédigent et se mettent en file
d'attente, la synchronisation se fait au retour du réseau. Le réseau est un bonus, pas un
prérequis.

Ce n'est pas une optimisation : c'est ce qui rend l'application utilisable là où elle est
destinée à servir. Voir [ADR-0002](docs/adr/0002-architecture-local-first.md).

## Les contraintes qui commandent tout

- **Réseau lent, cher et intermittent.** Une connexion tombe, revient dix minutes plus tard,
  disparaît pour la journée.
- **Android d'entrée de gamme.** 2 Go de RAM, Android 9, stockage limité.
- **Données comptées.** Compression agressive des médias, aucun téléchargement automatique
  hors Wi-Fi par défaut.
- **Budgets tenus.** Démarrage à froid sous 2 s, APK sous 40 Mo, mémoire sous 250 Mo —
  mesurés, bloquants ([ADR-0006](docs/adr/0006-budget-de-performance.md)).

## Prérequis

| Outil          | Version | Note                                                |
| -------------- | ------- | --------------------------------------------------- |
| Node           | ≥ 20.19 | La version exacte utilisée en CI est dans `.nvmrc`. |
| pnpm           | ≥ 10    | Voir l'installation ci-dessous.                     |
| Android Studio | récent  | Pour l'émulateur Android.                           |
| Xcode          | récent  | macOS uniquement, pour l'émulateur iOS.             |

**pnpm n'est pas fourni avec Node.** Sous Windows, `corepack enable` échoue sans droits
administrateur car il tente d'écrire dans `C:\Program Files\nodejs`. Dans ce cas :

```bash
npm install -g pnpm@10
```

> Le chemin du dépôt ne devrait pas contenir d'espace : Gradle échoue régulièrement dessus
> lors des builds Android locaux. Les builds EAS, qui compilent dans le cloud, n'y sont pas
> sensibles.

## Installation

```bash
git clone https://github.com/Nova2026-graphik/kola.git
cd kola
pnpm install
```

L'installation configure aussi les hooks Git (Husky), qui vérifient le style au commit et
le format des messages.

## Lancer l'application

```bash
pnpm --filter mobile dev
```

Puis `a` pour ouvrir sur Android, `i` sur iOS.

**Expo Go ne suffira pas au-delà du jalon M2.** SQLite, la compression média et la lecture
automatique du SMS sont des modules natifs : il faudra un build de développement
(`eas build --profile development`). Pour l'instant, `pnpm --filter mobile dev:go`
fonctionne avec Expo Go.

## Vérifications

```bash
pnpm lint          # ESLint sur tout le monorepo
pnpm typecheck     # TypeScript strict, tous les paquets
pnpm test          # Vitest (arrive en #71)
pnpm format        # Prettier en écriture
```

Ces quatre commandes sont exactement ce que la CI exécute sur chaque PR.

## Base de données locale

Les migrations et les policies RLS se testent sur une base Postgres locale, lancée par
Docker. Aucun compte Supabase n'est nécessaire.

```bash
pnpm db:start    # démarre Postgres + Auth (Docker requis)
pnpm db:reset    # rejoue toutes les migrations à neuf
pnpm db:test     # exécute la suite pgTAP
pnpm db:lint     # linter SQL de Supabase
pnpm db:stop     # arrête le stack
```

> Sous Windows, les ports Supabase par défaut (54321+) tombent dans une plage réservée par
> le système. Ils sont décalés vers 54021+ dans `supabase/config.toml` ; vérifiez vos
> propres plages avec `netsh int ipv4 show excludedportrange protocol=tcp` si le démarrage
> échoue sur une erreur de socket.

Une policy RLS ne se relit pas, elle se teste : toute migration touchant aux permissions
doit être accompagnée de son test pgTAP, en cas passant **et** en cas refusé.

## Structure du dépôt

```
kola/
├── apps/mobile/            # application Expo (iOS + Android)
├── packages/core/          # types partagés, schémas Zod, constantes
├── packages/api/           # client Supabase typé + repositories
├── packages/ui/            # design system React Native
├── supabase/migrations/    # SQL versionné
├── supabase/functions/     # Edge Functions
├── docs/adr/               # décisions d'architecture
└── .github/workflows/      # CI et release
```

## Variables d'environnement

Aucun secret n'est versionné. Copiez `.env.example` en `.env` et renseignez les valeurs :

```bash
cp .env.example .env
```

Les clés Supabase se récupèrent dans le tableau de bord du projet, section _API_. La clé
`service_role` ne doit **jamais** apparaître côté client : elle vit exclusivement dans les
secrets des Edge Functions.

## Décisions d'architecture

Les choix structurants sont consignés dans [`docs/adr/`](docs/adr/README.md), avec leurs
alternatives écartées et les raisons du rejet. À lire avant de proposer un changement de
fond :

- [ADR-0001 — Choix de la stack](docs/adr/0001-choix-de-la-stack.md)
- [ADR-0002 — Architecture local-first](docs/adr/0002-architecture-local-first.md)
- [ADR-0003 — Pas de chiffrement de bout en bout en V1](docs/adr/0003-pas-de-e2ee-en-v1.md)
- [ADR-0004 — Choix de Supabase](docs/adr/0004-choix-de-supabase.md)
- [ADR-0005 — Stratégie de release](docs/adr/0005-strategie-de-release.md)
- [ADR-0006 — Budget de performance](docs/adr/0006-budget-de-performance.md)

## Contribuer

Voir [CONTRIBUTING.md](CONTRIBUTING.md) : charte de branches, format des commits, cycle de
vie d'une PR.

## Statut

Jalon M0 (Fondations) en cours. Le backlog complet est dans les
[issues](https://github.com/Nova2026-graphik/kola/issues), organisé en jalons M0 à M15.
