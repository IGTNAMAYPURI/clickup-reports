import type { Config } from 'jest';
import baseConfig from './jest.config';

const config: Config = {
  ...baseConfig,
  roots: ['<rootDir>/tests/unit'],
  testMatch: ['**/tests/unit/**/*.test.ts'],
};

export default config;
