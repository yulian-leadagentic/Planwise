/**
 * QA6 P10 · PR-079 — stale tabs still open `/api/ws`. Their WebSocket
 * upgrade must get a fast 404 (it used to hang for a second and then be
 * dropped, which Railway logged as a 502); Socket.IO's own path is left
 * alone.
 */
import * as http from 'http';
import * as net from 'net';
import type { AddressInfo } from 'net';

import { rejectStrayWebSocketUpgrades } from './ws-upgrade-guard';

function upgradeRequest(path: string): string {
  return [
    `GET ${path} HTTP/1.1`,
    'Host: localhost',
    'Connection: Upgrade',
    'Upgrade: websocket',
    'Sec-WebSocket-Version: 13',
    'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==',
    '',
    '',
  ].join('\r\n');
}

/** Sends a raw upgrade and collects what the server writes within `waitMs`. */
function sendUpgrade(port: number, path: string, waitMs = 300): Promise<string> {
  return new Promise((resolve) => {
    const socket = net.connect(port, '127.0.0.1');
    let received = '';
    const done = () => {
      socket.destroy();
      resolve(received);
    };
    const timer = setTimeout(done, waitMs);
    socket.on('data', (chunk) => {
      received += chunk.toString('utf8');
    });
    socket.on('end', () => {
      clearTimeout(timer);
      done();
    });
    socket.on('error', () => {
      clearTimeout(timer);
      done();
    });
    socket.write(upgradeRequest(path));
  });
}

describe('rejectStrayWebSocketUpgrades', () => {
  let server: http.Server;
  let port: number;
  // Upgraded sockets leave the HTTP server's bookkeeping; close them ourselves.
  const upgraded = new Set<import('stream').Duplex>();

  beforeAll(async () => {
    server = http.createServer((_req, res) => res.end('ok'));
    rejectStrayWebSocketUpgrades(server);
    server.on('upgrade', (_req, socket) => upgraded.add(socket));
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    port = (server.address() as AddressInfo).port;
  });

  afterAll(async () => {
    for (const socket of upgraded) socket.destroy();
    server.closeAllConnections?.();
    await new Promise<void>((r) => server.close(() => r()));
  });

  it('answers the old /api/ws upgrade with an immediate 404', async () => {
    const started = Date.now();
    const response = await sendUpgrade(port, '/api/ws/?EIO=4&transport=websocket', 2000);
    expect(response.startsWith('HTTP/1.1 404 Not Found')).toBe(true);
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it('leaves Socket.IO upgrades to Socket.IO', async () => {
    const response = await sendUpgrade(port, '/socket.io/?EIO=4&transport=websocket', 200);
    expect(response).toBe('');
  });
});
