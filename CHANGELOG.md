# Changelog

Toutes les modifications notables de Kola sont consignées ici.

Le format suit [Keep a Changelog](https://keepachangelog.com/fr/1.1.0/), et le projet
applique le [versionnement sémantique](https://semver.org/lang/fr/).

## [Non publié]

### Ajouté

- Monorepo pnpm + Turborepo, TypeScript en mode strict, paquets `@kola/core`, `@kola/api`
  et `@kola/ui` (#1)
- ESLint, Prettier, commitlint et hooks Git — dont une règle interdisant aux écrans
  d'importer le client Supabase, garde-fou du local-first (#2)
- Application Expo SDK 57 avec `expo-router` : layout racine, groupes de routes `(auth)` et
  `(app)`, route `+not-found`, `minSdkVersion` 28 et minification R8 en release (#3)
- Workflow CI GitHub Actions : formatage, lint, typecheck, tests et conformité des messages
  de commit sur chaque PR (#4)
- ADR 0001 à 0006 : stack, architecture local-first, absence de chiffrement de bout en bout
  en V1, choix de Supabase, stratégie de release, budget de performance (#5)
- README, CONTRIBUTING, modèle de PR, gabarits d'issue, code de conduite (#6)
- Schéma de données complet : `profiles`, `devices`, `conversations`,
  `conversation_members`, `messages`, `attachments`, `reactions`, `receipts`,
  `contacts`, `blocks`, `reports` (#8, #9, #10, #11, #12)
- Idempotence de l'envoi par `client_id` unique, et attribution du `seq` monotone par
  conversation sous verrou de ligne (#10)
- Fonctions `SECURITY DEFINER` `is_member`, `is_admin`, `is_blocked`,
  `is_blocked_in_conversation` et `can_read_message` (#13)
- Policies RLS sur toutes les tables, avec deux garde-fous vérifiés à la migration :
  aucune table sans RLS, aucune fonction `SECURITY DEFINER` exécutable par `anon` (#14)
- Aperçu dénormalisé et compteurs de non-lus à coût constant, vue
  `conversation_overview` (#15)
- Base Supabase locale et suite de 89 tests pgTAP (`pnpm db:reset`, `pnpm db:test`)
