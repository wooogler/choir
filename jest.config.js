/** @type {import('jest').Config} */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/__tests__'],
  testMatch: [
    '**/__tests__/**/*.test.+(ts|tsx|js)',
    '**/*.(test|spec).+(ts|tsx|js)'
  ],
  testPathIgnorePatterns: [
    '/node_modules/',
    '/__tests__/setup.ts'
  ],
  transform: {
    '^.+\\.(ts|tsx)$': 'ts-jest'
  },
  collectCoverageFrom: [
    'src/**/*.{ts,tsx}',
    'services/**/*.{ts,tsx}',
    'listeners/**/*.{ts,tsx}',
    '!**/*.d.ts',
    '!**/node_modules/**'
  ],
  moduleNameMapper: {
    '^@/services/(.*)$': '<rootDir>/services/$1',
    '^@/listeners/(.*)$': '<rootDir>/listeners/$1',
    '^@/types$': '<rootDir>/src/types/index',
    '^@/constants$': '<rootDir>/src/constants/index',
    '^@/config$': '<rootDir>/src/config/index',
    '^@/utils$': '<rootDir>/src/utils/index',
    '^services/(.*)$': '<rootDir>/services/$1'
  },
  setupFilesAfterEnv: ['<rootDir>/__tests__/setup.ts']
};