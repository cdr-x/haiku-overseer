import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/tests/**/*.test.ts"],
  },
  resolve: {
    alias: [
      // Redirect .js imports to .ts source files
      { find: /^(.+)\.js$/, replacement: "$1.ts" },
    ],
  },
});
