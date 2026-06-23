const nextJest = require("next/jest");

const createJestConfig = nextJest({ dir: "./" });

/** @type {import('jest').Config} */
const config = {
  testEnvironment: "jsdom",
  setupFilesAfterEnv: ["<rootDir>/jest.setup.ts"],
  moduleNameMapper: {
    "^@/(.*)$": "<rootDir>/$1",
    "^@sms/types/(.*)$": "<rootDir>/../../packages/types/src/$1",
    "^@sms/types$": "<rootDir>/../../packages/types/src/index.ts",
    "^@sms/tokens$": "<rootDir>/../../packages/tokens/src/index.ts",
  },
};

module.exports = createJestConfig(config);
