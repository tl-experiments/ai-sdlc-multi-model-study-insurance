import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Pass 1 web → talks to Pass 1 backend on :3000.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5174,
    proxy: {
      "/api": {
        target: "http://localhost:3000",
        changeOrigin: true,
        rewrite: (p) => p.replace(/^\/api/, ""),
      },
    },
  },
  build: { outDir: "dist" },
});
