# ADR-0001 — Choix de la stack

- **Statut** : Accepté
- **Date** : 2026-09-09
- **Concerne** : #1, #3

## Contexte

Kola vise l'Afrique de l'Ouest, à commencer par le Togo. Trois contraintes commandent
tout le reste :

1. **Le parc d'appareils.** Android d'entrée de gamme domine largement : 2 Go de RAM,
   Android 9, stockage limité. iOS existe mais reste minoritaire.
2. **L'équipe.** Deux à cinq personnes. Il n'y a pas de marge pour maintenir deux bases
   de code natives, ni pour exploiter une infrastructure lourde.
3. **Le réseau.** Lent, cher, intermittent. Ce point est traité en profondeur dans
   l'[ADR-0002](0002-architecture-local-first.md), mais il pèse déjà sur le choix
   d'outils : il faut pouvoir livrer un correctif sans imposer un téléchargement de
   40 Mo à l'utilisateur.

## Décision

- **Mobile** : Expo (SDK récent) + React Native + TypeScript en mode strict, routage par
  `expo-router`.
- **État** : Zustand pour l'état d'interface, TanStack Query pour les données serveur.
- **Base locale** : SQLite via `expo-sqlite`, avec Drizzle ORM.
- **Backend** : Supabase — Postgres, Auth, Realtime, Storage, Edge Functions
  (voir [ADR-0004](0004-choix-de-supabase.md)).
- **Monorepo** : pnpm workspaces + Turborepo.
- **Tests** : Vitest (unitaire), pgTAP (RLS), Maestro (bout en bout).

Expo, et non React Native nu, pour trois raisons précises : EAS Build produit des binaires
iOS sans machine macOS ; EAS Update permet de livrer un correctif JavaScript sans repasser
par la revue des stores ; et la gestion des modules natifs par plugins évite de maintenir
à la main les projets Xcode et Gradle.

## Alternatives écartées

**Flutter.** Techniquement solide, et son moteur de rendu donne des performances régulières
sur appareils modestes. Écarté sur l'écosystème : Dart isole des bibliothèques JavaScript,
et surtout il n'existe pas d'équivalent d'EAS Update pour livrer un correctif hors des
stores — capacité que nous jugeons décisive sur ce marché.

**Développement natif (Kotlin + Swift).** Le meilleur résultat possible en performance et
en intégration système. Écarté sur le coût : deux bases de code pour une équipe de deux à
cinq personnes signifie soit tout faire deux fois, soit abandonner iOS.

**Application web progressive.** Attirante sur le papier — pas d'installation, pas de
store. Écartée sur trois manques rédhibitoires ici : notifications push peu fiables sur
iOS, accès aux contacts inexistant, et stockage local sujet à éviction silencieuse par le
navigateur, ce qui ruine l'architecture local-first.

**Backend maison (Node ou Go + Postgres).** Plus de contrôle, aucun enfermement. Écarté
sur le délai : réécrire authentification, temps réel, stockage de fichiers et permissions
représente plusieurs mois avant le premier message envoyé.

## Conséquences

**Ce que cela rend facile.** Une base de code pour deux plateformes. Des correctifs
livrables en minutes. Un typage partagé de bout en bout, du schéma Postgres jusqu'aux
écrans. Une équipe réduite qui reste productive.

**Ce que cela rend difficile.** Les performances brutes restent en deçà du natif :
le budget de l'[ADR-0006](0006-budget-de-performance.md) doit être défendu en continu.
Chaque module natif ajouté alourdit l'APK et le démarrage à froid. Certaines intégrations
système — CallKit, ConnectionService (#89) — demanderont du code natif malgré Expo.

**Ce que cela interdit.** Expo Go ne suffira pas : SQLite, compression média et lecture
automatique du SMS imposent des builds de développement dès le jalon M3. Il faut le prévoir
dans l'organisation de l'équipe.

**Le risque principal** est la dépendance à l'infrastructure EAS. Il est atténué par la
possibilité de faire `expo prebuild` et de compiler soi-même : la porte de sortie existe,
même si elle coûte.
