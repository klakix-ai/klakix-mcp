import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const src = (path: string) => fileURLToPath(new URL(path, import.meta.url));

export default defineConfig({
  resolve: {
    // Run the example against package sources so `npm test` works without a build.
    alias: {
      "@klakix/mcp-oauth": src("./packages/mcp-oauth/src/index.ts"),
      "@klakix/mcp-server": src("./packages/mcp-server/src/index.ts"),
    },
  },
  test: {
    include: ["packages/*/test/**/*.test.ts", "examples/*/test/**/*.test.ts"],
    environment: "node",
  },
});
