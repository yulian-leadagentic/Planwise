import { defineConfig } from 'vitest/config';
import { loadEnv } from 'vite';
import react from '@vitejs/plugin-react-swc';
import { sentryVitePlugin } from '@sentry/vite-plugin';
import path from 'path';

// API proxy target is per-developer (3000 vs 3010 etc.), so it reads from
// `VITE_API_PROXY` in apps/web/.env.local (gitignored). Falling back to
// 3010 keeps the historical default; the .env.local survives reverts of
// this file. To change ports, edit .env.local and restart `npm run dev`.
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, __dirname, '');
  const apiProxyTarget = env.VITE_API_PROXY || 'http://localhost:3010';

  // Sentry source-map upload runs only when SENTRY_AUTH_TOKEN is present at
  // build time — same fail-open rule as runtime init. Missing token ⇒ plugin
  // skipped, `pnpm --filter web build` still succeeds. The token is a
  // build-time secret set on the Railway web service.
  //
  // The release tag ties uploaded maps to the events Sentry ingests:
  // Railway injects RAILWAY_GIT_COMMIT_SHA automatically; VITE_SENTRY_RELEASE
  // is the manual override (same convention as the backend).
  const sentryAuthToken = process.env.SENTRY_AUTH_TOKEN;
  const sentryOrg = process.env.SENTRY_ORG;
  const sentryProject = process.env.SENTRY_PROJECT;
  const sentryRelease =
    process.env.VITE_SENTRY_RELEASE ?? process.env.RAILWAY_GIT_COMMIT_SHA;

  const plugins = [react()];
  if (sentryAuthToken && sentryOrg && sentryProject) {
    plugins.push(
      sentryVitePlugin({
        authToken: sentryAuthToken,
        org: sentryOrg,
        project: sentryProject,
        release: sentryRelease ? { name: sentryRelease } : undefined,
        sourcemaps: {
          assets: 'apps/web/dist/**',
        },
        // Silence plugin logs unless the build is failing — Railway build
        // logs stay readable.
        silent: true,
        // A build without a release SHA still uploads, but stack traces
        // won't be tied to a specific version. Warn loudly so an operator
        // notices before it becomes routine.
        errorHandler: (err) => {
          console.warn('[sentry-vite-plugin] non-fatal:', err.message);
        },
      }),
    );
  }

  return {
    plugins,
    resolve: {
      alias: {
        '@': path.resolve(__dirname, './src'),
        '@amec/shared': path.resolve(__dirname, '../../packages/shared/src'),
      },
      dedupe: ['react', 'react-dom', '@dnd-kit/core', '@dnd-kit/sortable', '@dnd-kit/utilities'],
    },
    // Emit source maps so `sentryVitePlugin` has something to upload. The
    // Sentry plugin auto-deletes uploaded maps from `dist/` when
    // `sourcemaps.filesToDeleteAfterUpload` is set — we intentionally leave
    // that off so a browser dev-tools session (without the Sentry token)
    // can still walk into readable code during triage. If ever concerned
    // about map leakage, flip that switch.
    build: {
      sourcemap: true,
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
