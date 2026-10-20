import type { Config } from 'jest';

/**
 * End-to-end tests: boot the real Nest application against a real Postgres.
 * Requires DATABASE_URL (see README, "Running the tests").
 */
const config: Config = {
  moduleFileExtensions: ['js', 'json', 'ts'],
  rootDir: '..',
  roots: ['<rootDir>/test'],
  testRegex: '.*\\.e2e-spec\\.ts$',
  setupFiles: ['<rootDir>/test/setup-env.ts'],
  transform: {
    '^.+\\.(t|j)s$': ['ts-jest', { tsconfig: '<rootDir>/tsconfig.json' }],
  },
  // Prisma's generated client imports siblings as `./x.js` (correct for compiled
  // output); map them back to the `.ts` sources when running under ts-jest.
  moduleNameMapper: { '^(\\.{1,2}/.*)\\.js$': '$1' },
  testEnvironment: 'node',
  testTimeout: 30_000,
};

export default config;
