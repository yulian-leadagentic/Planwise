import type { Server } from 'http';
import type { Duplex } from 'stream';

/** Socket.IO's engine path (every gateway uses the default). */
export const SOCKET_IO_PATH = '/socket.io/';

const NOT_FOUND =
  'HTTP/1.1 404 Not Found\r\n' +
  'Connection: close\r\n' +
  'Content-Type: text/plain; charset=utf-8\r\n' +
  'Content-Length: 10\r\n' +
  '\r\n' +
  'Not Found\n';

/**
 * QA6 P10 · PR-079 — a WebSocket upgrade to any path but Socket.IO's
 * gets an immediate 404.
 *
 * Browser tabs still running a pre-round-4 bundle open
 * `GET /api/ws/?EIO=4&transport=websocket`. Socket.IO's engine ignores
 * an upgrade on a foreign path and, after 1 s, closes the TCP socket
 * without writing a byte (`destroyUpgrade`) — Railway's edge reports
 * that as 502 "connection closed unexpectedly", once per reconnect
 * attempt. Answering 404 right away ends each attempt cleanly. The
 * engine's own timer then finds the socket already closed and does
 * nothing.
 */
export function rejectStrayWebSocketUpgrades(server: Pick<Server, 'on'>, socketIoPath = SOCKET_IO_PATH): void {
  server.on('upgrade', (req: { url?: string }, socket: Duplex) => {
    const url = req?.url ?? '';
    if (url.startsWith(socketIoPath)) return; // Socket.IO handles it.
    socket.on('error', () => {
      /* the client may already be gone */
    });
    if (socket.writable) socket.end(NOT_FOUND);
  });
}
