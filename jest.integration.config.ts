import type { Config } from 'jest';
import baseConfig from './jest.config';

const config: Config = {
  ...baseConfig,
  roots: ['<rootDir>/tests/integration'],
  testMatch: ['**/tests/integration/**/*.integration.test.ts'],
  testTimeout: 60000,
};

export default config;
