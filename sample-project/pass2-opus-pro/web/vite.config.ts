import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Pass 2: Opus + Gemini Pro web → talks to its backend on :3001.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5175,
    proxy: {
      "/api": {
        target: "http://localhost:3001",
        changeOrigin: true,
        rewrite: (p) => p.replace(/^\/api/, ""),
      },
    },
  },
  build: { outDir: "dist" },
});
