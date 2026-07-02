// @ts-check
import js from "@eslint/js";
import tseslint from "typescript-eslint";

/** Shared ESLint flat config. Consumers spread this array and append their own overrides. */
export default tseslint.config(
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      // CPU-budget discipline (docs/01 §4.1): unbounded loops/sync work in
      // Workers request handlers are a correctness risk, not just style.
      "no-await-in-loop": "warn",
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
      "@typescript-eslint/consistent-type-imports": "error"
    }
  },
  {
    ignores: ["dist/**", ".turbo/**", "node_modules/**", ".wrangler/**"]
  }
);
