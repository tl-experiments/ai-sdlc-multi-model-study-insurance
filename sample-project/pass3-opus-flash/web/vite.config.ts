import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Pass 3: Opus + Gemini Flash web → talks to its backend on :3002.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5176,
    proxy: {
      "/api": {
        target: "http://localhost:3002",
        changeOrigin: true,
        rewrite: (p) => p.replace(/^\/api/, ""),
      },
    },
  },
  build: { outDir: "dist" },
});
