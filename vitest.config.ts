import { defineConfig } from "vitest/config";

// Deliberately free of the Cloudflare plugin: the engine is pure TypeScript
// with no Workers runtime dependency, so it tests fastest in plain Node.
export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    environment: "node",
  },
});
