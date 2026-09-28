import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["scripts/gate2/*.eval.ts"],
    environment: "node",
    testTimeout: 600_000,
  },
});
