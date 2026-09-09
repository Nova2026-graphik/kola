# ADR-0006 — Budget de performance

- **Statut** : Accepté
- **Date** : 2026-09-09
- **Concerne** : #30, #74, #76

## Contexte

L'appareil de référence de Kola n'est pas un téléphone de développeur. C'est un Android
d'entrée de gamme : 2 Go de RAM, Android 9, processeur modeste, stockage presque plein.

Sur ce genre d'appareil, la dérive de performance est insidieuse. Chaque dépendance ajoutée
coûte quelques centaines de millisecondes au démarrage et quelques mégaoctets d'APK. Aucun
commit n'est clairement fautif, et six mois plus tard l'application est désinstallée sans
que personne ne sache exactement quand elle est devenue inutilisable.

Un budget chiffré, mesuré automatiquement, est la seule parade qui tienne.

## Décision

**Trois budgets, mesurés à chaque build, bloquants en cas de dépassement.**

| Budget            | Seuil    | Mesure                                                             |
| ----------------- | -------- | ------------------------------------------------------------------ |
| Démarrage à froid | < 2 s    | Lancement jusqu'au premier écran utilisable, appareil de référence |
| Taille de l'APK   | < 40 Mo  | Artefact de build EAS, profil `production`                         |
| Mémoire           | < 250 Mo | Après défilement complet d'une conversation de 5 000 messages      |

Quatre budgets secondaires, non bloquants mais suivis :

| Indicateur                                     | Cible    |
| ---------------------------------------------- | -------- |
| Affichage de la liste des conversations        | < 500 ms |
| Ouverture d'une conversation de 5 000 messages | < 1 s    |
| Lecture de 50 messages depuis SQLite           | < 16 ms  |
| Recherche plein texte sur 50 000 messages      | < 200 ms |

### Méthode de mesure

**L'appareil de référence est un téléphone réel et modeste, jamais un émulateur.** Un
émulateur sur une machine de développement démarre trois à quatre fois plus vite qu'un
appareil d'entrée de gamme et donne une fausse assurance. Le modèle exact retenu sera
consigné dans `docs/performance.md` (#74).

- **Démarrage à froid** : mesuré côté application, du démarrage du processus au premier
  rendu utilisable, et corroboré par `adb shell am start -W` sur Android.
- **Taille de l'APK** : lue sur l'artefact EAS, comparée d'un build à l'autre.
- **Mémoire** : relevée après un scénario de défilement scripté, via les outils de profilage
  de la plateforme.
- **En production** : Sentry remonte les temps de démarrage réels des utilisateurs. C'est la
  mesure qui compte au bout du compte — la nôtre n'en est qu'une approximation.

### Application

Un dépassement d'un budget bloquant **fait échouer le build** avec un message explicite.
Ce n'est pas négociable au cas par cas : si un budget doit changer, c'est par un nouvel
ADR, pas par une exception dans un pipeline.

## Alternatives écartées

**Pas de budget, mesure ponctuelle avant chaque release.** C'est ce qui se pratique le plus
souvent. Écarté parce que la mesure arrive trop tard : au moment où le dépassement est
constaté, la cause est diluée dans des dizaines de commits.

**Budgets plus larges** (démarrage à 4 s, APK à 80 Mo), alignés sur les usages courants du
secteur. Écartés parce que ces seuils supposent un appareil et un réseau qui ne sont pas
ceux de nos utilisateurs. 80 Mo à télécharger représente une part significative d'un forfait
mensuel.

**Mesure sur émulateur**, plus simple à automatiser. Écartée : elle mesure la machine de CI,
pas l'expérience réelle.

## Conséquences

**Ce que cela rend facile.** Une régression est attribuée au commit qui l'a causée. Le
refus d'une dépendance lourde devient un argument chiffré plutôt qu'une opinion.

**Ce que cela rend difficile.** Certaines bibliothèques confortables seront refusées :
jeux d'icônes complets, familles de polices entières, bibliothèques d'emoji embarquant
plusieurs mégaoctets d'images. Il faudra parfois écrire un composant plutôt que l'installer.

**Leviers disponibles** en cas de dépassement, du moins au plus coûteux : Hermes (déjà
activé), minification R8 et suppression des ressources inutilisées (déjà activées),
découpage par ABI, chargement différé des écrans secondaires, réduction des assets, et en
dernier recours retrait d'une dépendance native.

**Point de vigilance.** L'index FTS de la recherche locale (#36) double approximativement
la taille de la base SQLite. Ce n'est pas dans les budgets ci-dessus, mais cela pèse sur
l'occupation de stockage vue par l'utilisateur, et doit être pris en compte dans la
politique de purge du cache média (#48).
