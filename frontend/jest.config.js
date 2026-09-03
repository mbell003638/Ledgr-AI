const path = require('path');

/** Jest config — only tests the pure accounting module (no React Native deps needed). */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  testMatch: ['**/__tests__/**/*.test.ts'],
  // Only the pure accounting module is unit-tested here; RN screens need a
  // separate jest-expo setup which isn't required for the accounting engine.
  roots: ['<rootDir>/__tests__'],
  // Resolve the app's `@/` path alias (mirrors tsconfig paths) so tests can drive
  // the real api.ts layer end-to-end, not just the pure engine.
  moduleNameMapper: {
    '^@/(.*)$': path.join(__dirname, '$1'),
    '^expo-auth-session$': path.join(__dirname, '__tests__/mocks/expo-auth-session.ts'),
    '^expo-web-browser$': path.join(__dirname, '__tests__/mocks/expo-web-browser.ts'),
    '^expo-file-system/legacy$': path.join(__dirname, '__tests__/mocks/expo-file-system-legacy.ts'),
  },
};
