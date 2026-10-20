import globals from 'globals';
import tseslint from 'typescript-eslint';
import { base } from './base.js';

/** NestJS API rules (Node runtime, Jest tests). */
export const nest = tseslint.config(
  ...base,
  {
    languageOptions: {
      globals: { ...globals.node, ...globals.jest },
    },
    rules: {
      // Nest relies on decorated classes whose constructor-injected params are
      // referenced only through metadata; `consistent-type-imports` must not
      // turn those into type-only imports or DI breaks at runtime.
      '@typescript-eslint/consistent-type-imports': 'off',
      '@typescript-eslint/no-extraneous-class': 'off',
    },
  },
  {
    files: ['**/*.spec.ts', '**/*.e2e-spec.ts', 'test/**/*.ts'],
    rules: {
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/unbound-method': 'off',
    },
  },
);

export default nest;
