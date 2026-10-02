import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath } from "node:url";

export default defineConfig(({ command }) => {
  const apiPort = process.env.VITE_API_PORT;
  if (
    command === "serve" &&
    (!apiPort || !/^\d+$/.test(apiPort) || Number(apiPort) < 1 || Number(apiPort) > 65535)
  ) {
    throw new Error(
      "VITE_API_PORT must be the listening API port; use npm run dev for coordinated startup"
    );
  }
  return {
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
    // client's relative /api calls resolve. The launcher discovers the actual API port.
    server: {
      strictPort: true,
      proxy: {
        "/api": `http://${process.env.HOST ?? "127.0.0.1"}:${apiPort}`,
      },
    },
  };
});
