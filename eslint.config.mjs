import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';
import globals from 'globals';
import security from 'eslint-plugin-security';

export default tseslint.config(
  {
    ignores: ['dist/**', 'coverage/**', 'node_modules/**', 'perf/**', '.claude/worktrees/**'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    // `eslint-plugin-security` is registered here (rule definitions only, none
    // enabled — this config never turns on any `security/...` rule, that's
    // `eslint.security.config.mjs`'s job) purely so this main pass doesn't
    // choke on the `// eslint-disable-next-line security/...` directive below
    // (in `src/lib/credentials.ts`) — without this, ESLint reports
    // "Definition for rule ... was not found" as an error on that line under
    // this config, which has nothing to do with the main lint and would fail
    // `lint:fix`/CI for unrelated reasons. Mirrors the same accommodation
    // `eslint.security.config.mjs` makes in the other direction for
    // `@typescript-eslint/...` disable comments.
    plugins: { security },
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: {
        ...globals.node,
      },
    },
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      '@typescript-eslint/consistent-type-imports': 'error',
      'no-console': 'off',
    },
  },
  prettier,
);
