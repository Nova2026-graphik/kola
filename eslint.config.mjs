import js from '@eslint/js';
import prettier from 'eslint-config-prettier';
import { createTypeScriptImportResolver } from 'eslint-import-resolver-typescript';
import importX from 'eslint-plugin-import-x';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    // Rien de généré, compilé ou installé n'est analysé.
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/.expo/**',
      '**/.turbo/**',
      '**/coverage/**',
      '**/android/**',
      '**/ios/**',
      '**/*.tsbuildinfo',
      // Fichier régénéré par `pnpm db:types` (#16), jamais édité à la main.
      'packages/core/src/database.types.ts',
      // Fonctions Edge : Deno, pas Node. Elles importent depuis JSR et
      // utilisent le global `Deno`, que la résolution TypeScript de ce dépôt ne
      // connaît pas. Leur vérification passe par `deno check`, pas par ESLint.
      'supabase/functions/**',
    ],
  },

  js.configs.recommended,
  ...tseslint.configs.recommended,

  {
    files: ['**/*.{ts,tsx,mts,cts}'],
    plugins: { 'import-x': importX },
    languageOptions: {
      parserOptions: {
        projectService: {
          // Les fichiers de configuration de la racine n'appartiennent à aucun
          // tsconfig : sans cette autorisation, le service de projet les rejette.
          allowDefaultProject: ['*.mts', '*.mjs', '*.cjs'],
        },
        tsconfigRootDir: import.meta.dirname,
      },
    },
    settings: {
      'import-x/resolver-next': [createTypeScriptImportResolver({ alwaysTryTypes: true })],
    },
    rules: {
      // Un import de type émis comme import de valeur casse le tree-shaking
      // et alourdit le bundle : le budget d'APK est de 40 Mo (ADR 0006).
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', fixStyle: 'inline-type-imports' },
      ],
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      // `any` explicite est un aveu : on le signale sans bloquer.
      '@typescript-eslint/no-explicit-any': 'warn',
      'import-x/no-unresolved': 'error',
      'import-x/order': [
        'error',
        {
          groups: ['builtin', 'external', 'internal', 'parent', 'sibling', 'index'],
          pathGroups: [{ pattern: '@kola/**', group: 'internal', position: 'before' }],
          // Les paquets du workspace sont vus comme externes (ils vivent dans
          // node_modules via pnpm) ; sans cela le pathGroup ci-dessus est ignoré.
          pathGroupsExcludedImportTypes: [],
          'newlines-between': 'always',
          alphabetize: { order: 'asc', caseInsensitive: true },
        },
      ],
      'no-console': ['warn', { allow: ['warn', 'error'] }],
      eqeqeq: ['error', 'smart'],
    },
  },

  // Application mobile : hooks React et règle d'architecture local-first.
  {
    files: ['apps/mobile/**/*.{ts,tsx}'],
    plugins: { 'react-hooks': reactHooks },
    rules: {
      ...reactHooks.configs.recommended.rules,
    },
  },
  {
    // Garde-fou de l'ADR 0002 : l'interface lit SQLite, jamais le réseau.
    // Les écrans passent par les repositories (#28), jamais par le client Supabase.
    files: ['apps/mobile/app/**/*.{ts,tsx}'],
    rules: {
      'import-x/no-restricted-paths': 'off',
      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: '@supabase/supabase-js',
              message:
                "L'interface ne lit jamais le réseau directement. Passer par un repository (voir docs/adr/0002-architecture-local-first.md).",
            },
          ],
          patterns: [
            {
              group: ['@kola/api/*', '**/supabase/client*'],
              message:
                "L'interface ne lit jamais le réseau directement. Passer par un repository (voir docs/adr/0002-architecture-local-first.md).",
            },
          ],
        },
      ],
    },
  },

  // Fichiers de configuration : hors du projet TypeScript, exécutés par Node.
  {
    files: ['**/*.{js,mjs,cjs}'],
    ...tseslint.configs.disableTypeChecked,
    languageOptions: {
      globals: { ...globals.node },
    },
  },

  // Toujours en dernier : neutralise les règles de style qui entrent en conflit avec Prettier.
  prettier,
);
