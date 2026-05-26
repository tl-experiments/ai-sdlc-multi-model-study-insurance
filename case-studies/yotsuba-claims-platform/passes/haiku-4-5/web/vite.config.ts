import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';

// Track B refinement: original proxy stripped the /api prefix and didn't
// proxy /auth/* at all. Fixed: pass both /api and /auth through to the
// mock backend at :3000 with the prefix preserved.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5176,
    strictPort: false,
    proxy: {
      '/api':  { target: process.env.VITE_API_URL || 'http://localhost:3000', changeOrigin: true },
      '/auth': { target: process.env.VITE_API_URL || 'http://localhost:3000', changeOrigin: true },
    },
  },
  build: { outDir: 'dist', sourcemap: true, minify: 'terser', target: 'ES2020' },
  resolve: { alias: { '@': path.resolve(__dirname, './src') } },
});
