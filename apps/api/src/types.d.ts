declare module 'pdfkit';
// nodemailer ships no typings (no @types/nodemailer in the lockfile);
// NotificationsService narrows the transport to the one method it uses.
declare module 'nodemailer';
declare module 'socket.io' {
  export class Server {
    to(room: string): { emit(event: string, data: any): void };
    /** The sockets in a room (the messaging gateway re-checks each before a broadcast). */
    in(room: string): { fetchSockets(): Promise<Socket[]> };
    emit(event: string, data: any): void;
  }
  export class Socket {
    id: string;
    handshake: {
      query: Record<string, string>;
      auth: Record<string, unknown>;
      headers: Record<string, string | string[] | undefined>;
    };
    /** Per-socket app data — the gateways keep the authenticated user here. */
    data: any;
    rooms: Set<string>;
    join(room: string): void;
    leave(room: string): void;
    emit(event: string, data?: any): boolean;
    disconnect(close?: boolean): this;
  }
}
