/** Jest config for the API (unit specs + the RLS e2e suite under test/). */
module.exports = {
  preset: "ts-jest",
  testEnvironment: "node",
  rootDir: ".",
  roots: ["<rootDir>/src", "<rootDir>/test"],
  testRegex: ".*\\.(spec|e2e-spec)\\.ts$",
  moduleNameMapper: {
    "^@sms/types/(.*)$": "<rootDir>/../../packages/types/src/$1",
    "^@sms/types$": "<rootDir>/../../packages/types/src/index.ts",
    "^@sms/game-engine$": "<rootDir>/../../packages/game-engine/src/index.ts",
  },
  transform: {
    "^.+\\.ts$": ["ts-jest", { tsconfig: "<rootDir>/tsconfig.json" }],
  },
};
