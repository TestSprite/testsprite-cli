import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.{test,spec}.ts', 'test/**/*.{test,spec}.ts'],
    exclude: ['test/dev-e2e/**', 'test/e2e/**', 'node_modules/**', 'dist/**'],
    // Strip real TESTSPRITE_* env vars and redirect the home dir so results
    // never depend on the developer's shell or ~/.testsprite (see the file).
    setupFiles: ['./test/helpers/hermetic-env.ts'],
    // Build the CLI exactly once, before any test file/worker spawns, so the
    // subprocess/snapshot suites never race an in-suite rebuild against a
    // concurrent spawn of the binary they're still writing.
    globalSetup: ['./test/global-setup.ts'],
    // Kept as defense-in-depth: forces test files to run one at a time in a
    // single worker, so no other per-file hook can race dist/ either.
    fileParallelism: false,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'text-summary', 'json-summary', 'html'],
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.{test,spec}.ts', 'src/**/*.d.ts', 'src/index.ts'],
      thresholds: {
        lines: 80,
        functions: 80,
        branches: 80,
        statements: 80,
      },
    },
  },
});
