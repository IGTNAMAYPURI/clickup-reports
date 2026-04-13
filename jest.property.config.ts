import type { Config } from 'jest';
import baseConfig from './jest.config';

const config: Config = {
  ...baseConfig,
  roots: ['<rootDir>/tests/property'],
  testMatch: ['**/tests/property/**/*.property.test.ts'],
  testTimeout: 30000,
};

export default config;
