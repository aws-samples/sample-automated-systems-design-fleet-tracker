/** @type {import('jest').Config} */
module.exports = {
  preset: "ts-jest",
  testEnvironment: "node",
  roots: ["<rootDir>/lambdas", "<rootDir>/simulator"],
  testMatch: ["**/*.test.ts"],
  moduleFileExtensions: ["ts", "js", "json"],
  collectCoverageFrom: [
    "lambdas/**/*.ts",
    "simulator/**/*.ts",
    "!lambdas/**/*.test.ts",
    "!simulator/**/*.test.ts",
    "!lambdas/**/*.d.ts",
    "!simulator/**/*.d.ts",
  ],
  coverageDirectory: "coverage",
  coverageReporters: ["text", "lcov", "html"],
  verbose: true,
};
