import { next } from '@ftms/eslint-config/next';

export default [
  ...next,
  { ignores: ['eslint.config.mjs'] },
  {
    languageOptions: {
      parserOptions: { tsconfigRootDir: import.meta.dirname },
    },
  },
];
