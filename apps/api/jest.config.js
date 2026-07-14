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
    // The app tsconfig is `module: nodenext` (modern resolution, matches the
    // build). Jest runs on CommonJS, so tests compile through tsconfig.spec.json
    // — it EXTENDS tsconfig.json (inheriting strict, decorators, emitDecorator-
    // Metadata, types, etc.) and only flips module/moduleResolution back to a
    // CommonJS-compatible pair so ts-jest emits requireable CJS.
    "^.+\\.ts$": ["ts-jest", { tsconfig: "<rootDir>/tsconfig.spec.json" }],
  },
};
