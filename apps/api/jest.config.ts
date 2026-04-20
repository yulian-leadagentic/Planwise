import type { Config } from 'jest';

/**
 * Jest configuration for unit tests. Integration tests that require a real
 * database should live under `test/` and use a separate `jest-e2e.json`
 * (already referenced by the `test:e2e` npm script).
 *
 * Unit tests follow the convention `*.spec.ts` colocated with the file
 * they test, e.g. `src/modules/tasks/tasks.service.spec.ts`.
 */
const config: Config = {
  rootDir: '.',
  testEnvironment: 'node',
  testRegex: '.*\\.spec\\.ts$',
  testPathIgnorePatterns: ['/node_modules/', '/dist/', '/test/'],
  moduleFileExtensions: ['js', 'json', 'ts'],
  moduleNameMapper: {
    '^@/(.*)$': '<rootDir>/src/$1',
  },
  transform: {
    '^.+\\.ts$': ['ts-jest', { tsconfig: '<rootDir>/tsconfig.json' }],
  },
  collectCoverageFrom: [
    'src/**/*.ts',
    '!src/**/*.spec.ts',
    '!src/**/*.dto.ts',
    '!src/**/*.module.ts',
    '!src/main.ts',
  ],
  coverageDirectory: 'coverage',
  clearMocks: true,
};

export default config;
