/**
 * Conventional Commits.
 *
 * Ce n'est pas cosmétique : ces messages alimentent la génération du CHANGELOG
 * et des notes de version du pipeline de release (#80).
 */
module.exports = {
  extends: ['@commitlint/config-conventional'],
  rules: {
    'type-enum': [
      2,
      'always',
      [
        'feat', // nouvelle fonctionnalité
        'fix', // correction de bug
        'chore', // outillage, dépendances, maintenance
        'docs', // documentation, ADR
        'refactor', // remaniement sans changement de comportement
        'perf', // amélioration de performance
        'test', // ajout ou correction de tests
        'build', // build, EAS, packaging
        'ci', // intégration continue
        'revert', // annulation d'un commit
      ],
    ],
    'scope-enum': [
      2,
      'always',
      ['mobile', 'core', 'api', 'ui', 'db', 'ci', 'docs', 'deps', 'release'],
    ],
    // La portée reste facultative : certains changements sont transverses.
    'scope-empty': [0],
    'subject-case': [0],
    'body-max-line-length': [0],
    'footer-max-line-length': [0],
  },
};
