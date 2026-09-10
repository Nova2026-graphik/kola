import { defineConfig } from 'vitest/config';

/**
 * Tests unitaires du monorepo.
 *
 * Ils tournent sous Node, jamais dans React Native : les repositories et le
 * moteur de synchronisation sont conçus pour être testables sans émulateur
 * (voir `apps/mobile/src/db/testing.ts`).
 *
 * La configuration complète, avec seuils de couverture, arrive en #71.
 */
export default defineConfig({
  test: {
    environment: 'node',
    include: ['{apps,packages}/*/src/**/*.test.ts'],
    // Ces tests écrivent dans des bases SQLite en mémoire, indépendantes les
    // unes des autres : rien ne les empêche de tourner en parallèle.
    pool: 'threads',
    coverage: {
      provider: 'v8',
      include: ['apps/mobile/src/repositories/**', 'apps/mobile/src/db/**', 'packages/core/src/**'],
      exclude: ['**/*.test.ts', 'apps/mobile/src/db/testing.ts', 'apps/mobile/src/db/client.ts'],
      reporter: ['text', 'lcov'],
    },
  },
});
