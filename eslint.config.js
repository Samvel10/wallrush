/**
 * Lint configuration.
 *
 * TypeScript's strict mode already covers most of what a linter would catch, so
 * this deliberately keeps to the rules that types cannot express: React's hook
 * dependency analysis (the single biggest source of subtle UI bugs), floating
 * promises, and a handful of correctness checks that are easy to trip over.
 * Style is not enforced — that is what a formatter is for.
 */

import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/node_modules/**',
      'packages/client/public/sw.js',
      'eslint.config.js',
    ],
  },

  js.configs.recommended,
  ...tseslint.configs.recommended,

  {
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: { ...globals.node, ...globals.browser },
    },
    rules: {
      // Unused code is usually a leftover, but a leading underscore is the
      // conventional way to say "required by the signature, not needed here".
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none' },
      ],
      // `any` is a deliberate escape hatch in a few protocol boundaries.
      '@typescript-eslint/no-explicit-any': 'warn',
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      'no-var': 'error',
      'prefer-const': 'error',
      'no-constant-binary-expression': 'error',
      'no-self-compare': 'error',
      'no-unmodified-loop-condition': 'error',
      'require-atomic-updates': 'error',
    },
  },

  {
    files: ['packages/client/src/**/*.{ts,tsx}'],
    plugins: { 'react-hooks': reactHooks },
    rules: {
      ...reactHooks.configs.recommended.rules,
      // A stale dependency array is a real bug, not a style preference.
      'react-hooks/exhaustive-deps': 'error',
    },
  },

  {
    // Tests deliberately reach into internals and build odd positions.
    files: ['**/test/**/*.ts', '**/*.test.ts'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unused-expressions': 'off',
    },
  },

  {
    files: ['scripts/**/*.mjs'],
    languageOptions: { globals: globals.node },
    rules: { '@typescript-eslint/no-unused-vars': 'off' },
  },
);
