import type { Config } from 'jest';

/** Unit tests: `src/**\/*.spec.ts`. No database, network, or `.env` files. */
const config: Config = {
  moduleFileExtensions: ['js', 'json', 'ts'],
  rootDir: '.',
  roots: ['<rootDir>/src'],
  testRegex: '.*\\.spec\\.ts$',
  transform: {
    '^.+\\.(t|j)s$': ['ts-jest', { tsconfig: '<rootDir>/tsconfig.json' }],
  },
  collectCoverageFrom: ['src/**/*.ts', '!src/generated/**', '!src/main.ts', '!src/scripts/**'],
  coverageDirectory: './coverage',
  // Prisma's generated client imports siblings as `./x.js` (correct for compiled
  // output); map them back to the `.ts` sources when running under ts-jest.
  moduleNameMapper: { '^(\\.{1,2}/.*)\\.js$': '$1' },
  testEnvironment: 'node',
};

export default config;
