/** @type {import('@jest/types').Config.InitialOptions} */
module.exports = {
  moduleFileExtensions: ['js', 'json', 'ts'],
  rootDir: '.',
  testRegex: 'test/.*\.e2e-spec\.ts$|src/.*\.spec\.ts$',
  transform: {
    '^.+\\.(t|j)s$': 'ts-jest',
  },
  collectCoverageFrom: ['src/**/*.(t|j)s'],
  coverageDirectory: './coverage',
  testEnvironment: 'node',
  testTimeout: 30000,
  runInBand: true,
  forceExit: true,
  globals: {
    'ts-jest': {
      tsconfig: 'tsconfig.json',
    },
  },
  moduleNameMapper: {
    '^@common/(.*)$': '<rootDir>/src/common/$1',
    '^@auth/(.*)$': '<rootDir>/src/auth/$1',
    '^@claims/(.*)$': '<rootDir>/src/claims/$1',
    '^@reserves/(.*)$': '<rootDir>/src/reserves/$1',
    '^@audit/(.*)$': '<rootDir>/src/audit/$1',
    '^@appi/(.*)$': '<rootDir>/src/appi/$1',
  },
  setupFilesAfterFramework: [],
  verbose: true,
};