// Flat config: TypeScript sources only; generated, vendored and built output ignored.
import js from "@eslint/js";
import tsParser from "@typescript-eslint/parser";
import tsPlugin from "@typescript-eslint/eslint-plugin";
export default [
  { ignores: ["**/node_modules/**", "**/dist/**", "packages/db/migrations/**", "docs/**", "fixtures/**", "tmp/**", "data/**"] },
  js.configs.recommended,
  {
    files: ["**/*.ts", "**/*.tsx"],
    languageOptions: { parser: tsParser, parserOptions: { ecmaVersion: 2024, sourceType: "module" }, globals: { console: "readonly", process: "readonly", Buffer: "readonly", setTimeout: "readonly", clearTimeout: "readonly", setInterval: "readonly", clearInterval: "readonly", fetch: "readonly", Response: "readonly", Request: "readonly", URL: "readonly", URLSearchParams: "readonly", AbortController: "readonly", TextEncoder: "readonly", TextDecoder: "readonly", crypto: "readonly", document: "readonly", window: "readonly", localStorage: "readonly", sessionStorage: "readonly", navigator: "readonly", HTMLElement: "readonly", HTMLInputElement: "readonly", Event: "readonly", FormData: "readonly", File: "readonly", Blob: "readonly", performance: "readonly", RequestInit: "readonly", NodeJS: "readonly", KeyboardEvent: "readonly", MouseEvent: "readonly", requestAnimationFrame: "readonly", history: "readonly", location: "readonly", HTMLSelectElement: "readonly", HTMLTextAreaElement: "readonly", Image: "readonly", alert: "readonly", confirm: "readonly" } },
    plugins: { "@typescript-eslint": tsPlugin },
    rules: { ...tsPlugin.configs.recommended.rules, "no-unused-vars": "off", "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrors: "none" }], "@typescript-eslint/no-explicit-any": "error", "no-undef": "off", "no-redeclare": "off", "no-empty": ["error", { allowEmptyCatch: true }], "no-constant-condition": ["error", { checkLoops: false }], "@typescript-eslint/no-namespace": "off", "@typescript-eslint/no-require-imports": "off" },
  },
];
