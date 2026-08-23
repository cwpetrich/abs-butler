import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * The SPA lives in web/ and builds into dist/public, which the Node server
 * serves. In development `npm run dev:web` proxies /api to a `serve` process
 * on 13380 so the UI runs against real data.
 */
export default defineConfig({
  root: 'web',
  plugins: [react()],
  build: {
    outDir: '../dist/public',
    emptyOutDir: true,
  },
  server: {
    port: 5473,
    proxy: {
      '/api': {
        target: process.env.BUTLER_DEV_API ?? 'http://localhost:13380',
        changeOrigin: false,
      },
    },
  },
});
