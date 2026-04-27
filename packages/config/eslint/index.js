/** @type {import('eslint').Linter.Config} */
const base = {
  parser: '@typescript-eslint/parser',
  plugins: ['@typescript-eslint', 'react-hooks'],
  extends: [
    'eslint:recommended',
    'plugin:@typescript-eslint/recommended',
    'plugin:@typescript-eslint/recommended-requiring-type-checking',
    'plugin:react-hooks/recommended',
  ],
  rules: {
    // TypeScript strict rules
    '@typescript-eslint/no-explicit-any': 'error',
    '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
    '@typescript-eslint/consistent-type-imports': ['error', { prefer: 'type-imports' }],
    '@typescript-eslint/no-non-null-assertion': 'error',
    '@typescript-eslint/strict-boolean-expressions': 'error',
    '@typescript-eslint/no-floating-promises': 'error',
    '@typescript-eslint/await-thenable': 'error',
    '@typescript-eslint/no-misused-promises': 'error',

    // React Hooks rules
    'react-hooks/rules-of-hooks': 'error',
    'react-hooks/exhaustive-deps': 'warn',

    // General quality
    'no-console': ['warn', { allow: ['warn', 'error'] }],
    'prefer-const': 'error',
    'no-var': 'error',
  },
  ignorePatterns: ['node_modules', 'dist', '.next', 'build', '*.config.*', '*.config.ts'],
};

/** @type {import('eslint').Linter.Config} */
const nextjs = {
  ...base,
  extends: [...(base.extends ?? []), 'next/core-web-vitals'],
  rules: {
    ...base.rules,
    '@next/next/no-html-link-for-pages': 'error',
  },
};

/** @type {import('eslint').Linter.Config} */
const node = {
  ...base,
  env: {
    node: true,
    es2022: true,
  },
};

module.exports = { base, nextjs, node };
