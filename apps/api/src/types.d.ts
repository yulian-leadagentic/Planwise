declare module 'pdfkit';
declare module 'socket.io' {
  export class Server {
    to(room: string): { emit(event: string, data: any): void };
    emit(event: string, data: any): void;
  }
  export class Socket {
    id: string;
    handshake: { query: Record<string, string> };
    join(room: string): void;
    leave(room: string): void;
  }
}
