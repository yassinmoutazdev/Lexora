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
    /*
      Bound to IPv4 loopback explicitly, and the explicitness is the point.

      The default is `localhost`, which Node resolves to `::1` on this machine — IPv6 only. That is
      fine for a browser on this PC, and invisible until you try to reach the dev server from a
      phone over USB: `adb reverse tcp:5173 tcp:5173` forwards to the host over IPv4, so the
      connection arrives at `127.0.0.1:5173`, finds nothing listening, and dies. The symptom is a
      phone that cannot load the page while `curl localhost:5173` on the same machine returns 200 —
      which reads like a tunnel fault and is not one. Verified by elimination: the phone reached an
      IPv4-only probe through `adb reverse` while failing against this server.

      IPv4 loopback rather than `host: true`, deliberately. `host: true` would also work and would
      additionally serve the dev server over Wi-Fi, but it binds every interface — which puts the
      staff login, the dashboard and the student data on whatever network this laptop is on. USB is
      the only access this needs, so the narrower binding is the one to keep. To test over Wi-Fi
      instead, change this to `host: true` and accept that exposure.
    */
    host: '127.0.0.1',
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
