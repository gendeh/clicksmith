// Jest configuration for client
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  moduleNameMapper: {
    '^@/(.*)$': '<rootDir>/src/$1',
    '^@components/(.*)$': '<rootDir>/src/components/$1',
    '^@services/(.*)$': '<rootDir>/src/services/$1',
    '^@hooks/(.*)$': '<rootDir>/src/hooks/$1',
    '^@utils/(.*)$': '<rootDir>/src/utils/$1',
    '^@types/(.*)$': '<rootDir>/src/types/$1',
    '^screenshot-desktop$': '<rootDir>/tests/mocks/screenshotDesktop.js',
    '^robotjs$': '<rootDir>/tests/mocks/robotjs.js',
    '^electron$': '<rootDir>/tests/mocks/electron.js'
  },
  transform: {
    '^.+\\.tsx?$': ['ts-jest', {
      tsconfig: 'tsconfig.main.json'
    }]
  }
};
