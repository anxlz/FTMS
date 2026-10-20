import nextCoreWebVitals from 'eslint-config-next/core-web-vitals';
import nextTypescript from 'eslint-config-next/typescript';
import globals from 'globals';
import tseslint from 'typescript-eslint';
import { base } from './base.js';

/** Next.js web rules (React, browser + server components). */
export const next = tseslint.config(...base, ...nextCoreWebVitals, ...nextTypescript, {
  languageOptions: {
    globals: { ...globals.browser, ...globals.node },
  },
});

export default next;
