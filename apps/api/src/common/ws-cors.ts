/**
 * CORS origins for the Socket.IO gateways. FRONTEND_URL may be a
 * comma-separated list (same as the HTTP CORS setup in main.ts); passed
 * whole as one string, no browser origin would match it.
 */
export function socketCorsOrigins(raw = process.env.FRONTEND_URL): string[] {
  const list = (raw || 'http://localhost:5173')
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean);
  return list.length > 0 ? list : ['http://localhost:5173'];
}
