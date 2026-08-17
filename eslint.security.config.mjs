/**
 * Security-focused ESLint config used by the CI "Security" workflow only.
 * Run: npx eslint src/ --config eslint.security.config.mjs
 *
 * Ported from community PR https://github.com/TestSprite/testsprite-cli/pull/220
 * (author @OkeyAmy) with the ignore list trimmed to this repo's actual
 * conventions — see eslint.config.mjs for the shared ignore list.
 */
import security from 'eslint-plugin-security';
import tseslint from 'typescript-eslint';
import globals from 'globals';

export default tseslint.config(
  {
    ignores: ['dist/**', 'coverage/**', 'node_modules/**', 'perf/**', '.claude/worktrees/**'],
  },
  {
    files: ['**/*.ts', '**/*.mts', '**/*.cts'],
    // `@typescript-eslint` is registered here (rule definitions only, none
    // enabled) purely so this narrower config doesn't choke on the
    // `// eslint-disable-next-line @typescript-eslint/...` directives that
    // already exist in the tree for the MAIN lint pass — without this,
    // ESLint reports "Definition for rule ... was not found" as an error on
    // every such line under this config, which has nothing to do with
    // security and would fail the job for unrelated reasons.
    plugins: { ...security.configs.recommended.plugins, '@typescript-eslint': tseslint.plugin },
    languageOptions: {
      parser: tseslint.parser,
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: { ...globals.node },
    },
    rules: {
      ...security.configs.recommended.rules,
      // Block non-literal paths in fs calls — catches CWE-22, CWE-73
      'security/detect-non-literal-fs-filename': 'error',
      // Warn on object injection via bracket notation with user input
      'security/detect-object-injection': 'warn',
      // Warn on timing-unsafe comparisons (token equality checks)
      'security/detect-possible-timing-attacks': 'warn',
      // Warn on non-literal RegExp (ReDoS)
      'security/detect-non-literal-regexp': 'warn',
      // Error on child_process with non-literal args
      'security/detect-child-process': 'error',
      // Disable/reduce noisy rules for a CLI codebase
      'security/detect-non-literal-require': 'off',
      'security/detect-unsafe-regex': 'warn',
    },
  },
);
