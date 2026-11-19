import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/e2e/**/*.e2e.test.ts'],
    exclude: ['node_modules/**', 'dist/**'],
    // A spawned CLI inherits process.env: no GitHub job variables reach it.
    setupFiles: ['./test/helpers/no-github-job-env.ts'],
  },
});
