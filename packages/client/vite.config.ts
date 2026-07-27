import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const API = process.env.WALLRUSH_API ?? 'http://127.0.0.1:8787';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    host: true,
    proxy: {
      '/api': { target: API, changeOrigin: true },
      '/ws': { target: API.replace(/^http/, 'ws'), ws: true },
    },
  },
  build: {
    target: 'es2022',
    cssCodeSplit: false,
    rollupOptions: {
      output: {
        // Keep the engine in its own chunk: it is imported by both the app and
        // the bot worker, and it changes far less often than the UI.
        manualChunks(id: string) {
          if (id.includes('packages/shared')) return 'engine';
          return undefined;
        },
      },
    },
  },
  worker: { format: 'es' },
});
