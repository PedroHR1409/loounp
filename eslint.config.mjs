import js from "@eslint/js";
import tseslint from "typescript-eslint";
import eslintConfigPrettier from "eslint-config-prettier";
import globals from "globals";

export default tseslint.config(
  {
    ignores: ["out/", "dist/", "node_modules/"],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    // Codebase convention: a leading underscore marks a deliberately unused binding
    // (dropped destructured field, mock parameter kept for signature/type reasons).
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          destructuredArrayIgnorePattern: "^_",
        },
      ],
    },
  },
  {
    files: [
      "src/main/**/*.ts",
      "src/preload/**/*.ts",
      "src/core/**/*.ts",
      "electron.vite.config.ts",
      "vitest*.config.ts",
    ],
    languageOptions: {
      globals: globals.node,
    },
  },
  {
    files: ["src/renderer/**/*.ts"],
    languageOptions: {
      globals: globals.browser,
    },
  },
  eslintConfigPrettier,
);
