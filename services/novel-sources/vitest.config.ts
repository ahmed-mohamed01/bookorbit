import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    globals: true,
    // Starting plugin workers can take seconds on a loaded machine, such as a full monorepo test run.
    testTimeout: 20_000,
  },
});
