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
    // Use the test tsconfig (types: ["jest","node"]) so ts-jest resolves the
    // jest globals. The root tsconfig omits jest types and excludes __tests__,
    // which left `expect`/`it`/`describe` undefined during transform.
    '^.+\\.(ts|tsx)$': ['ts-jest', { tsconfig: '<rootDir>/__tests__/tsconfig.json' }],
    // The remark/unified/mdast ecosystem ships ESM-only; transform it (and other
    // ESM-only deps) so CommonJS jest can load modules that import them.
    '^.+\\.(js|mjs)$': ['ts-jest', { tsconfig: '<rootDir>/__tests__/tsconfig.json' }]
  },
  transformIgnorePatterns: [
    // pnpm nests deps as .pnpm/<name>@<ver>/node_modules/<name>/. Ignore (skip
    // transform for) everything in .pnpm EXCEPT the ESM-only remark/unified/mdast
    // families, which must be transpiled to CJS for jest to load them.
    '/node_modules/\\.pnpm/(?!(unified|remark[^/]*|mdast[^/]*|micromark[^/]*|unist-util-[^/]*|vfile[^/]*|bail|trough|is-plain-obj|decode-named-character-reference|character-entities|devlop|ccount|zwitch|longest-streak|markdown-table|escape-string-regexp)@)'
  ],
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
    '^services/(.*)$': '<rootDir>/services/$1',
    '^types/(.*)$': '<rootDir>/src/types/$1'
  },
  setupFilesAfterEnv: ['<rootDir>/__tests__/setup.ts']
};