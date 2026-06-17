import { defineConfig } from 'vitest/config';
import { loadEnv } from 'vite';
import react from '@vitejs/plugin-react-swc';
import path from 'path';

// API proxy target is per-developer (3000 vs 3010 etc.), so it reads from
// `VITE_API_PROXY` in apps/web/.env.local (gitignored). Falling back to
// 3010 keeps the historical default; the .env.local survives reverts of
// this file. To change ports, edit .env.local and restart `npm run dev`.
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, __dirname, '');
  const apiProxyTarget = env.VITE_API_PROXY || 'http://localhost:3010';
  return {
    plugins: [react()],
    resolve: {
      alias: {
        '@': path.resolve(__dirname, './src'),
        '@amec/shared': path.resolve(__dirname, '../../packages/shared/src'),
      },
      dedupe: ['react', 'react-dom', '@dnd-kit/core', '@dnd-kit/sortable', '@dnd-kit/utilities'],
    },
    test: {
      globals: true,
      environment: 'node',
      include: ['src/**/*.spec.ts'],
    },
    server: {
      port: 5173,
      proxy: {
        '/api': {
          target: apiProxyTarget,
          changeOrigin: true,
        },
      },
    },
  };
});
