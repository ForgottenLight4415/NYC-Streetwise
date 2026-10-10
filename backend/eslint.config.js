import js from "@eslint/js";
import globals from "globals";

// ESLint's recommended rules over every backend file: the API (src, api), the
// build and verification scripts, and the tests. Node ESM throughout, per
// package.json's "type": "module". Tests import describe/it/expect from vitest
// explicitly, so they need no test-framework globals.
export default [
  js.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      globals: globals.node,
    },
    rules: {
      "no-unused-vars": [
        "error",
        {
          // `_next`: Express error handlers must declare all four parameters.
          argsIgnorePattern: "^_",
          // `const { _id, ...rest } = doc` is how a field is dropped from a copy.
          ignoreRestSiblings: true,
        },
      ],
    },
  },
];
