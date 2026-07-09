/**
 * Security-focused ESLint config used by CI security job only.
 * Run: npx eslint src/ --config eslint.security.config.mjs
 *
 * Requires eslint-plugin-security to be installed:
 *   npm install --no-save eslint-plugin-security
 */
import security from 'eslint-plugin-security';
import tseslint from 'typescript-eslint';
import globals from 'globals';

export default tseslint.config(
  {
    ignores: ['dist/**', 'coverage/**', 'node_modules/**', 'sandbox/**'],
  },
  security.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: { ...globals.node },
    },
    rules: {
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
