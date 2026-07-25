/** Jest config — only tests the pure accounting module (no React Native deps needed). */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  testMatch: ['**/__tests__/**/*.test.ts'],
  // Only the pure accounting module is unit-tested here; RN screens need a
  // separate jest-expo setup which isn't required for the accounting engine.
  roots: ['<rootDir>/__tests__'],
};
