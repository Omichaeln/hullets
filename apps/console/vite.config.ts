import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";

const apiOrigin = process.env.VITE_API_ORIGIN || "https://promoapi-production-8258.up.railway.app";

export default defineConfig({
  plugins: [react()],
  resolve: { alias: { "@promo/core": path.resolve(__dirname, "../../packages/core/src") } },
  server: {
    host: "0.0.0.0",
    port: 5173,
    allowedHosts: ["promoconsole-production.up.railway.app"],
    proxy: { "/trpc": apiOrigin, "/api": apiOrigin, "/health": apiOrigin },
  },
  build: { outDir: "dist", sourcemap: false, target: "es2022", chunkSizeWarningLimit: 900 },
});
