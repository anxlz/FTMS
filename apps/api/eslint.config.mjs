import { nest } from '@ftms/eslint-config/nest';

export default [
  ...nest,
  { ignores: ['api/**', 'public/**', 'eslint.config.mjs'] },
  {
    languageOptions: {
      parserOptions: { tsconfigRootDir: import.meta.dirname },
    },
  },
  {
    // CLI scripts report to the terminal directly.
    files: ['src/scripts/**/*.ts'],
    rules: { 'no-console': 'off' },
  },
];
