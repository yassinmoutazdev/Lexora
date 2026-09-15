import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { defineConfig } from 'vite';

// `--config frontend/vite.config.ts` does not make Vite treat frontend/ as the project root —
// root still defaults to process.cwd() (the repository root). Set it explicitly so index.html,
// src/, and the build output all resolve inside frontend/.
const frontendDir = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  root: frontendDir,

  // React is compiled by esbuild's automatic JSX runtime rather than @vitejs/plugin-react.
  // The plugin is not part of the dependency set in ARCHITECTURE Section 2; esbuild covers the
  // transform in both dev and build. The trade-off is no React Fast Refresh in dev.
  esbuild: {
    jsx: 'automatic',
  },

  build: {
    outDir: 'dist', // → frontend/dist, served as static assets by Express in production
    emptyOutDir: true,
    sourcemap: true,
  },

  server: {
    port: 5173,
    // The SPA is served by the Vite dev server during development, but the API lives in the
    // Express process. Proxy keeps the browser on a single origin, matching production where
    // both are served from one process.
    proxy: {
      '/api': {
        target: `http://localhost:${process.env.PORT ?? 3000}`,
        changeOrigin: false,
      },
    },
  },
});
