/**
 * Jest configuration for the Yotsuba Insurance Claims Platform.
 *
 * Notes:
 * - The package.json already carries a `jest` block; this CJS config takes
 *   precedence when present and is the single source of truth for the test
 *   runner. Keep both in sync if you change one.
 * - Tests run against a real Postgres database (see test/* e2e specs). We
 *   therefore force `--runInBand` semantics via `maxWorkers: 1` to avoid
 *   cross-test DB contention, and give integration suites a generous
 *   timeout.
 * - The `web/` directory hosts the Vite + React workbench and has its own
 *   tooling; it is excluded from the backend Jest run.
 */

/** @type {import('jest').Config} */
module.exports = {
  moduleFileExtensions: ['js', 'json', 'ts'],
  rootDir: '.',
  roots: ['<rootDir>/src', '<rootDir>/test'],
  testRegex: '.*\\.(spec|e2e-spec)\\.ts$',
  transform: {
    '^.+\\.(t|j)s$': [
      'ts-jest',
      {
        tsconfig: '<rootDir>/tsconfig.json',
        isolatedModules: true,
      },
    ],
  },
  moduleNameMapper: {
    '^src/(.*)$': '<rootDir>/src/$1',
  },
  testEnvironment: 'node',
  testPathIgnorePatterns: [
    '/node_modules/',
    '/dist/',
    '/coverage/',
    '/web/',
  ],
  modulePathIgnorePatterns: ['<rootDir>/dist/', '<rootDir>/web/'],
  collectCoverageFrom: [
    'src/**/*.(t|j)s',
    '!src/**/*.module.ts',
    '!src/main.ts',
    '!src/**/dto/**',
    '!src/**/*.d.ts',
  ],
  coverageDirectory: './coverage',
  coverageReporters: ['text', 'lcov', 'html'],
  // Integration tests touch Postgres + run migrations; allow time for that.
  testTimeout: 30000,
  // Serialise tests — shared DB state would otherwise race.
  maxWorkers: 1,
  verbose: true,
  clearMocks: true,
  restoreMocks: true,
  forceExit: true,
  detectOpenHandles: false,
};