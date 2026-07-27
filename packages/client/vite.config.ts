import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * Stamps the service worker with a hash of the built assets.
 *
 * Without this the cache name never changes, so a returning visitor can be
 * served last week's bundle indefinitely. With it, every build that actually
 * changes something invalidates the old cache on activation.
 */
function stampServiceWorker(): Plugin {
  return {
    name: 'wallrush-sw-version',
    apply: 'build',
    closeBundle() {
      const dir = 'dist';
      const swPath = join(dir, 'sw.js');
      let sw: string;
      try {
        sw = readFileSync(swPath, 'utf8');
      } catch {
        return;
      }
      const hash = createHash('sha256');
      const assets = join(dir, 'assets');
      for (const name of readdirSync(assets).sort()) hash.update(name);
      hash.update(readFileSync(join(dir, 'index.html')));
      writeFileSync(swPath, sw.replace('__WALLRUSH_BUILD__', hash.digest('hex').slice(0, 12)));
    },
  };
}

const API = process.env.WALLRUSH_API ?? 'http://127.0.0.1:8787';

export default defineConfig({
  plugins: [react(), stampServiceWorker()],
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
