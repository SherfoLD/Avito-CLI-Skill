import js from '@eslint/js';
import globals from 'globals';

import avito from './scripts/lib/eslint-rules.mjs';

const repositoryRules = {
  'avito-cdp/no-silent-clamp': 'error',
  'avito-cdp/no-empty-catch-fallback': 'error',
  'avito-cdp/no-silent-sentinel': 'error',
  'avito-cdp/no-site-vocabulary': 'error',
};

export default [
  { ignores: ['node_modules/**', 'evidence/**'] },
  js.configs.recommended,
  {
    files: ['**/*.mjs'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: globals.node,
    },
    plugins: { 'avito-cdp': avito },
    rules: {
      ...repositoryRules,
      'no-unused-vars': ['error', { argsIgnorePattern: '^_', caughtErrors: 'none' }],
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      'no-console': 'off',
    },
  },
  {
    // These are serialized into the page, so they see the DOM and never `process`.
    files: ['src/browser/**/*.mjs', 'src/browser/commands/**/*.mjs'],
    languageOptions: { globals: globals.browser },
  },
  {
    // A suite carries the exact response Avito sent and a fixture the exact
    // request that was verified live, identifiers included. That is evidence,
    // not a pinned identifier.
    files: ['tests/**/*.mjs', 'verify/*.mjs'],
    rules: { 'avito-cdp/no-site-vocabulary': 'off' },
  },
];
