import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [react()],
  resolve: { alias: { "@": fileURLToPath(new URL("./src/client", import.meta.url)) } },
  test: {
    projects: [
      {
        test: {
          name: "client",
          include: ["tests/client/**/*.test.{ts,tsx}"],
          environment: "jsdom",
        },
      },
      {
        test: {
          name: "node",
          include: ["tests/boundary/**/*.test.{ts,tsx}", "tests/integration/**/*.test.{ts,tsx}"],
          environment: "node",
        },
      },
    ],
    setupFiles: ["./vitest.setup.ts"],
    passWithNoTests: false,
    allowOnly: false,
    fileParallelism: false,
    coverage: {
      provider: "v8",
      reporter: ["json", "json-summary", "text"],
      all: true,
      include: ["src/client/**/*.{ts,tsx}", "src/server/**/*.{ts,tsx}", "src/shared/**/*.{ts,tsx}"],
      exclude: ["**/*.d.ts"],
    },
  },
});
