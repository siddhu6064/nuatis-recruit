import { defineConfig } from "vitest/config";
import path from "path";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["tests/**/*.test.ts"],
    testTimeout: 30000,
    hookTimeout: 30000,
    singleThread: true,
    globalTeardown: ["tests/helpers/globalTeardown.ts"],
  },
  resolve: {
    alias: {
      "@workspace/auth": path.resolve(__dirname, "packages/auth/src/index.ts"),
      "@workspace/db": path.resolve(__dirname, "lib/db/src/index.ts"),
      "@workspace/audit": path.resolve(__dirname, "packages/audit/src/index.ts"),
    },
    conditions: ["development", "module", "import", "node", "default"],
  },
});
