import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * Vite build configuration — Code Guardian frontend.
 *
 * Key constraints (from architecture spec):
 *  - All API calls must use relative URLs (no hardcoded domain).
 *    In production, CloudFront sits in front of both the frontend and the
 *    backend, so the browser's origin is the same as the API origin.
 *  - In development, a proxy is configured so that /api/v1/** and the
 *    Socket.IO upgrade path are forwarded to the local backend container.
 *    This means frontend code never needs to know the backend host.
 */
export default defineConfig(({ mode }) => ({
  plugins: [react()],

  // ---- Development server ----
  server: {
    host: '0.0.0.0',
    port: 5173,
    watch: {
      // Required when running inside Docker (inotify is unavailable in most
      // container environments without extra kernel configuration).
      usePolling: true,
    },
    proxy: {
      /**
       * Forward all REST API requests to the backend.
       * Adjust the target URL to match the backend service in docker-compose.
       */
      '/api': {
        /**
         * In production (Docker Compose) this resolves to the `backend`
         * service hostname. For local development with the mock server set:
         *   BACKEND_URL=http://localhost:3001 pnpm dev
         */
        target: process.env.BACKEND_URL ?? 'http://backend:3000',
        changeOrigin: true,
        secure: false,
      },
      /**
       * Forward Socket.IO handshake and upgrade to the backend.
       * The ws: true flag enables WebSocket proxying.
       */
      '/socket.io': {
        target: process.env.BACKEND_URL ?? 'http://backend:3000',
        changeOrigin: true,
        ws: true,
        secure: false,
      },
    },
  },

  // ---- Production build ----
  build: {
    /**
     * Output directory — relative path so the Dockerfile COPY step works
     * regardless of where the build runs.
     */
    outDir: 'dist',

    /**
     * Generate source maps for production to assist with post-deployment
     * debugging. Set to false if bundle size is a concern.
     */
    sourcemap: mode !== 'production',

    rollupOptions: {
      output: {
        /**
         * Split vendor code into a separate chunk so the browser can cache
         * React, TanStack Router, etc. independently from application code.
         *
         * Forma a funzione: la forma a oggetto
         * (`{ vendor: ['react', ...] }`) non è più accettata dal bundler
         * usato da Vite 8, che fallisce la build con "manualChunks is not a
         * function". Il raggruppamento resta identico.
         */
        manualChunks(id: string) {
          const percorso = id.replace(/\\/g, '/');
          if (!percorso.includes('/node_modules/')) return;

          // Con pnpm il percorso reale è
          // .../node_modules/.pnpm/<pkg>@<ver>/node_modules/<pkg>/...:
          // l'ultimo segmento node_modules porta il nome vero.
          const dopoNodeModules = percorso.split('/node_modules/').pop() ?? '';
          const pacchetto = dopoNodeModules.startsWith('@')
            ? dopoNodeModules.split('/').slice(0, 2).join('/')
            : dopoNodeModules.split('/')[0];

          if (pacchetto === 'zustand') return 'state';
          if (pacchetto === 'axios' || pacchetto === 'socket.io-client') return 'network';
          if (
            pacchetto === 'react' ||
            pacchetto === 'react-dom' ||
            pacchetto === '@tanstack/react-router'
          ) {
            return 'vendor';
          }
        },
      },
    },
  },
}));
