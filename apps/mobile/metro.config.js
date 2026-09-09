// eslint-disable-next-line @typescript-eslint/no-require-imports
const { getDefaultConfig } = require('expo/metro-config');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const path = require('node:path');

const projectRoot = __dirname;
const workspaceRoot = path.resolve(projectRoot, '../..');

const config = getDefaultConfig(projectRoot);

// En monorepo, Metro ne surveille que le dossier du projet par défaut :
// une modification dans packages/core ne déclencherait aucun rechargement.
config.watchFolders = [workspaceRoot];

// L'ordre compte : les dépendances de l'app priment sur celles de la racine.
config.resolver.nodeModulesPaths = [
  path.resolve(projectRoot, 'node_modules'),
  path.resolve(workspaceRoot, 'node_modules'),
];

// Deux copies de React dans le graphe font échouer les hooks à l'exécution,
// avec un message qui ne pointe pas vers la cause. On coupe court.
config.resolver.disableHierarchicalLookup = true;

module.exports = config;
