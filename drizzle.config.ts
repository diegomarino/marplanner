import { defineConfig } from "drizzle-kit";

export default defineConfig({
  out: "drizzle",
  schema: "src/server/db/schema.ts",
  dialect: "sqlite",
  verbose: true,
} satisfies Record<string, unknown>);
