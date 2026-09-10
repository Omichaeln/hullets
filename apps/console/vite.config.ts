import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";
export default defineConfig({
  plugins: [react()],
  resolve: { alias: { "@promo/core": path.resolve(__dirname, "../../packages/core/src") } },
  server: { port: 5173, proxy: { "/trpc": "http://127.0.0.1:8080", "/api": "http://127.0.0.1:8080", "/health": "http://127.0.0.1:8080" } },
  build: { outDir: "dist", sourcemap: false, target: "es2022", chunkSizeWarningLimit: 900 },
});
