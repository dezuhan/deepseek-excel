import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

const rootDir = path.dirname(fileURLToPath(import.meta.url));

/**
 * The task pane is built into `dist/` and served by the local server at /taskpane.html.
 * - assetsDir 'ui' so it does not collide with /assets/* (add-in ribbon icons).
 * - The engine (bridge, agent, office-api, i18n) is still loaded as a plain <script>
 *   from the local server, so it is not bundled and remains testable in Node.
 */
export default defineConfig({
  root: path.join(rootDir, 'ui'),
  base: '/',
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: { '@': path.join(rootDir, 'ui', 'src') },
  },
  build: {
    outDir: path.join(rootDir, 'dist'),
    emptyOutDir: true,
    assetsDir: 'ui',
    target: 'chrome114',
    sourcemap: false,
  },
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
    proxy: {
      '/api': { target: 'https://localhost:3000', secure: false, changeOrigin: false },
      '/shared': { target: 'https://localhost:3000', secure: false, changeOrigin: false },
      '/js': { target: 'https://localhost:3000', secure: false, changeOrigin: false },
      '/pane-token.js': { target: 'https://localhost:3000', secure: false, changeOrigin: false },
    },
  },
});
