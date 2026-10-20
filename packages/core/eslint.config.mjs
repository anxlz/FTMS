import { base } from '@ftms/eslint-config/base';

export default [
  ...base,
  {
    languageOptions: {
      parserOptions: { tsconfigRootDir: import.meta.dirname },
    },
  },
];
