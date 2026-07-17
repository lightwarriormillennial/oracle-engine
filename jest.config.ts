import type { Config } from 'jest';

const config: Config = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/src'],
  testMatch: ['**/*.spec.ts'],
  moduleFileExtensions: ['ts', 'js', 'json'],
  // NestJS apps use experimental decorators + metadata — ts-jest must honour them.
  transform: {
    '^.+\\.ts$': ['ts-jest', { tsconfig: {
      experimentalDecorators: true, emitDecoratorMetadata: true,
      target: 'ES2022', module: 'commonjs', skipLibCheck: true,
    } }],
  },
};

export default config;
