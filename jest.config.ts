import type { Config } from 'jest';

const config: Config = {
  testEnvironment: 'node',
  extensionsToTreatAsEsm: ['.ts'],
  moduleNameMapper: {
    '^(\\.{1,2}/.*)\\.js$': '$1',
  },
  transform: {
    '^.+\\.tsx?$': '<rootDir>/tests/jest-esbuild-transformer.mjs',
  },
  testMatch: ['**/tests/**/*.test.ts'],
  testTimeout: 60000,
};

export default config;
