import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath } from "node:url";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src/client", import.meta.url)),
    },
  },
  root: ".",
  build: {
    // Client build lives under dist/client/ — the ONLY dir Fastify serves. The
    // server bundle goes to dist/server/ (outside the served root) so it can't leak.
    outDir: "dist/client",
    emptyOutDir: true,
  },
  // Dev only (ADR-056): Vite HMR proxies /api to the Fastify server so the
  // client's relative /api calls resolve. Run `npm run dev:server` alongside.
  server: {
    proxy: {
      "/api": "http://localhost:3000",
    },
  },
});
