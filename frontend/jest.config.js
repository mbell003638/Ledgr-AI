/** Jest config — only tests the pure accounting module (no React Native deps needed). */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  testMatch: ['**/__tests__/**/*.test.ts'],
  moduleNameMapper: {
    '^react-native$': '<rootDir>/__tests__/helpers/reactNativeMock.js',
    '^@react-native-async-storage/async-storage$': '<rootDir>/__tests__/helpers/asyncStorageMock.js',
    '^@/(.*)$': '<rootDir>/$1',
  },
  roots: ['<rootDir>/__tests__'],
};
