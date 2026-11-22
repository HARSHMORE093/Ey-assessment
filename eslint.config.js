"use strict";

const js = require("@eslint/js");
const globals = require("globals");

module.exports = [
  { ignores: ["node_modules/", "coverage/", ".serverless/", "dist/", "infra/cdk.out/", "infra/node_modules/"] },
  js.configs.recommended,
  {
    files: ["**/*.js"],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: "commonjs",
      globals: { ...globals.node },
    },
    rules: {
      "no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
      eqeqeq: ["error", "always"],
      "no-var": "error",
      "prefer-const": "error",
      strict: ["error", "global"],
    },
  },
  {
    files: ["tests/**/*.js", "infra/test/**/*.js"],
    languageOptions: { globals: { ...globals.jest } },
  },
];
