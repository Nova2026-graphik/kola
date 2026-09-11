# Livraison : builds et mises à jour à distance

Comment l'application arrive sur un téléphone, et comment les corrections y
arrivent ensuite sans réinstallation (#75, #76, #77, #78).

## Les deux chemins, et ce qui les sépare

|                  | Build                                       | Mise à jour à distance            |
| ---------------- | ------------------------------------------- | --------------------------------- |
| Contenu          | application complète, code natif compris    | JavaScript et assets uniquement   |
| Durée            | 10 à 25 minutes                             | une quinzaine de secondes         |
| Installation     | manuelle, l'utilisateur installe un fichier | automatique, au démarrage suivant |
| Nécessaire quand | le natif change                             | tout le reste                     |

**La règle qui décide** : si le changement touche une dépendance native, un
plugin de configuration, `expo-build-properties` ou la version du SDK Expo, il
faut un nouveau build. Sinon, une mise à jour suffit — et c'est le cas de la
très grande majorité du travail : écrans, logique, requêtes, corrections.

## `runtimeVersion` : la barrière de sécurité

Une mise à jour n'atteint que les applications dont la `runtimeVersion` est
**identique** à celle déclarée dans le paquet publié. C'est ce qui empêche
d'envoyer du JavaScript qui appellerait un module natif absent de l'application
installée — et de transformer un correctif en parc d'appareils qui ne démarre
plus.

Elle est fixée **explicitement** dans `app.config.ts`, actuellement à `'2'`.

Trois façons de la fixer existaient. Le choix mérite d'être connu, parce que les
deux autres ont chacune un défaut précis.

**`fingerprint`** la calcule depuis le projet natif : elle s'invalide toute
seule quand une dépendance native change. C'était la configuration initiale.
Le build l'a rejetée :

```
Runtime version calculated on local machine not equal to
runtime version calculated during build.
```

L'empreinte hache le contenu de `node_modules`, que pnpm n'installe pas à
l'identique sur un poste Windows et sur le serveur Linux d'EAS. La concordance
n'est pas garantie, et un build lancé depuis un poste de développement échoue
systématiquement.

**`appVersion`** la lie à `version`. Défaut inverse : `version` s'incrémente à
chaque livraison, y compris purement JavaScript, et chaque incrément couperait
les applications installées de toutes les mises à jour suivantes. La version
commerciale et la compatibilité native n'ont aucune raison d'avancer ensemble.

**Une valeur explicite** sépare les deux. Elle ne bouge que lorsque le natif
change.

> **Règle.** Incrémenter `runtimeVersion` dans le **même commit** que le
> changement natif, puis reconstruire et redistribuer. Publier une mise à jour
> après un changement natif sans avoir incrémenté est le seul scénario qui casse
> un appareil à distance.

## Canaux

| Canal         | Branche   | Qui le reçoit                       |
| ------------- | --------- | ----------------------------------- |
| `development` | —         | builds avec client de développement |
| `preview`     | `develop` | l'équipe, au quotidien              |
| `production`  | `main`    | le public                           |

Un build est attaché à un canal à la construction. Il écoute ce canal pour
toujours.

## Publier une mise à jour

Automatiquement : tout push sur `develop` publie sur `preview`, tout push sur
`main` publie sur `production` — voir `.github/workflows/update.yml`. Le workflow
passe d'abord `format:check`, `lint`, `typecheck` et les tests. Ce n'est pas une
formalité : une mise à jour à distance contourne la revue des stores et atteint
les appareils sans filet, donc ces vérifications sont le seul filet qui reste.

À la main, depuis `apps/mobile` :

```bash
npx eas-cli@latest update --channel preview --environment preview --message "ce que ça corrige"
```

Le secret `EXPO_TOKEN` doit exister dans les secrets du dépôt GitHub pour que le
workflow fonctionne. Il se crée sur https://expo.dev/settings/access-tokens.

## Construire

Depuis `apps/mobile` :

```bash
npx eas-cli@latest build --platform android --profile preview
```

`preview` produit un APK en distribution interne — installable directement,
sans passer par le Play Store. `production` produit un AAB signé, destiné au
Play Store.

## iOS

**Bloqué, et pas par la configuration.** Installer sur un iPhone exige
l'inscription à l'Apple Developer Program (99 $ par an) : Apple ne délivre pas
de certificat de distribution sans elle, et l'UDID de chaque appareil doit être
enregistré. Sans compte, EAS s'arrête :

```
EAS CLI couldn't find any credentials suitable for internal distribution.
```

Le profil iOS est déjà écrit dans `eas.json`. Une fois le compte ouvert, il
suffit de :

```bash
npx eas-cli@latest device:create
npx eas-cli@latest build --platform ios --profile preview
```

La première commande enregistre les appareils autorisés, la seconde construit.
Les identifiants sont gérés par EAS, rien n'est à conserver localement.

## Variables d'environnement

L'URL Supabase et la clé publishable vivent dans les variables d'environnement
EAS, par environnement (`development`, `preview`, `production`), et non dans
`eas.json`. Elles sont publiques par nature — le préfixe `EXPO_PUBLIC_` les
embarque dans le bundle — mais la règle du projet vaut quand même : rien de
configuré en dur dans le dépôt, sinon la prochaine valeur y sera secrète.

```bash
npx eas-cli@latest env:list --environment preview
```
