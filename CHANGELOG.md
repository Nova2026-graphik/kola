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
- Base Supabase locale et suite de tests pgTAP (`pnpm db:reset`, `pnpm db:test`)
- Base SQLite locale, schéma Drizzle miroir du schéma serveur, migrations locales
  versionnées et atomiques (#27)
- `MessageRepository` et `ConversationRepository` : lecture locale, écriture locale puis
  mise en file, dans une seule transaction (#28)
- File d'attente sortante : déduplication par entité, temporisation exponentielle avec
  part d'aléatoire, abandon sur erreur définitive (#28)
- Suite Vitest : 53 tests, 93 % de couverture sur la base locale et les repositories
  (`pnpm test`)
- Moteur de vidage de la file sortante : ordre préservé par conversation, passe unique,
  doublon serveur traité comme un succès (#54)
- Ordonnanceur : reprise au démarrage, au retour du réseau et en repli périodique (#54)
- Surveillance de l'état réseau : distinction entre absence de réseau et serveur
  injoignable, sonde de joignabilité espacée, déclenchement du vidage de la file au
  retour de la connexion (#55)
- Bandeau d'état réseau, informatif et non bloquant : le composeur reste toujours
  actif (#55)
- Types TypeScript générés depuis le schéma Postgres, avec vérification de fraîcheur en
  CI par empreinte des migrations (#16)
- Jeu de données de démonstration, cas limites et conversation de 5 000 messages
  compris (#17)
- Liste des conversations : tri, aperçu, badge de non-lus, recherche locale sans accent,
  états vides et squelettes (#29)
- Écran de conversation : liste inversée, pagination par curseur `seq`, séparateurs de
  date, groupement des salves, marqueur de nouveaux messages (#30)
- Formatage des dates, initiales et recherche, écrit à la main pour épargner les
  dizaines de kilooctets d'une bibliothèque de dates (#29, #30)
- Composeur : saisie multi-ligne, émoji système, brouillon persistant par conversation,
  jamais désactivé même hors ligne (#31)
- Envoi optimiste et cinq états d'acheminement distincts — en attente, envoyé, reçu, lu,
  échec — avec relance manuelle et bandeau récapitulatif (#32)
- Connexion par numéro de téléphone avec OTP SMS, indicatif +228 par défaut et
  normalisation E.164 tolérante aux formes réellement tapées (#19)
- Connexion par adresse e-mail avec code à six chiffres, sans lien à ouvrir (#20)
- Écran de saisie du code : vérification automatique au sixième chiffre, renvoi avec
  compte à rebours croissant, remplissage automatique (#21)
- Création du profil : pseudo unique vérifié en direct, nom affiché, avatar généré à
  partir des initiales (#22)
- Session persistante dans un stockage chiffré, découpée sous la limite de 2048 octets
  d'Android, avec rafraîchissement automatique (#23)
- Transport de la file d'attente sur PostgREST : idempotence par relecture du message
  existant, traduction des codes Postgres en erreurs transitoires ou définitives (#54)
- Chaîne de synchronisation câblée de bout en bout — transport, moteur, ordonnanceur,
  détecteur réseau (#54, #55)
- Projet Supabase de développement `kola-dev` en région `eu-west-3`, les onze migrations
  appliquées et vérifiées par les advisors de sécurité (#7)
- Sixième fichier pgTAP : privilèges d'exécution des fonctions `SECURITY DEFINER`, avec
  la règle inverse — ce que `authenticated` doit rester capable d'appeler (#14)
- Moteur de synchronisation delta : reprise par curseur, pagination, priorité aux
  conversations récemment ouvertes, détection d'un curseur incohérent, indicateur
  discret sans blocage de l'interface (#53)
- Suite de changements `change_seq` par conversation, distincte de `seq` : elle rattrape
  les messages modifiés ou supprimés après leur émission, qu'un curseur sur `seq` ne
  revoyait jamais (#53)

### Corrigé

- Les écritures faites hors des repositories — synchronisation delta et temps réel —
  étaient invisibles pour l'interface : le message arrivait en base et l'écran ne
  bougeait pas. L'émetteur de changements, jusque-là privé au repository, est désormais
  partagé (#50, #53)
- Les huit fonctions de trigger `SECURITY DEFINER` étaient exécutables par `anon` : le
  `ALTER DEFAULT PRIVILEGES` de Supabase les exposait, et le garde-fou de #14 les excluait
  parce que PostgreSQL refuse leur appel direct. Révoquées quand même — huit
  avertissements permanents dans le rapport d'advisors, et le neuvième passe inaperçu (#14)
- `messages.seq` n'était pas omissible à l'insertion, alors que c'est un trigger qui
  l'attribue : le client ne pouvait pas insérer de message sans inventer une valeur (#10)
- La suppression logique d'un message était impossible au-delà de quinze minutes : la
  contrainte de corps obligatoire et la fenêtre de modification se contredisaient. La
  suppression pour tous (#34) et la modération (#66) en dépendaient (#14)

