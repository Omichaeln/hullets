import { defineConfig } from "vitest/config";
export default defineConfig({ test: { include: ["tests/**/*.test.ts"], testTimeout: 120_000, hookTimeout: 300_000, fileParallelism: false, projects: [
  { test: { name: "unit", include: ["tests/unit/**/*.test.ts"] } },
  { test: { name: "integration", include: ["tests/integration/**/*.test.ts"], fileParallelism: false } },
  { test: { name: "ocr", include: ["tests/ocr/**/*.test.ts"], fileParallelism: false, testTimeout: 600_000 } },
] } });
