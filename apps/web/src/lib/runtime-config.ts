/**
 * Single source of truth for the API base URL.
 *
 * Resolution order:
 *   1. window.__APP_CONFIG__.apiUrl  — set at runtime by the container
 *      entrypoint from the API_URL env var (Railway split-services).
 *   2. import.meta.env.VITE_API_URL  — baked at build time. Useful for
 *      static hosts where you control the build env.
 *   3. ''                            — empty string = same-origin, relies
 *      on the nginx /api proxy in docker-compose / dev.
 */

declare global {
  interface Window {
    __APP_CONFIG__?: {
      apiUrl?: string;
    };
  }
}

function trimSlash(s: string): string {
  return s.replace(/\/$/, '');
}

function resolve(): string {
  if (typeof window !== 'undefined') {
    const fromWindow = window.__APP_CONFIG__?.apiUrl?.trim();
    if (fromWindow) return trimSlash(fromWindow);
  }
  const fromBuild = import.meta.env.VITE_API_URL?.trim();
  if (fromBuild) return trimSlash(fromBuild);
  return '';
}

export const API_BASE = resolve();
