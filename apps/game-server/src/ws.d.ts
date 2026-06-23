// Minimal ambient declaration for the subset of the `ws` package this server
// uses. `@types/ws` is not vendored here; this keeps the transport typecheckable
// and self-contained without pulling extra types. Extend if more surface is used.
declare module "ws" {
  import type { IncomingMessage } from "node:http";

  type RawData = Buffer | ArrayBuffer | Buffer[];

  class WebSocket {
    static readonly OPEN: number;
    readonly readyState: number;
    constructor(address: string);
    on(event: "open", listener: () => void): this;
    on(event: "message", listener: (data: RawData) => void): this;
    on(event: "close", listener: (code: number, reason: Buffer) => void): this;
    on(event: "error", listener: (err: Error) => void): this;
    send(data: string): void;
    close(code?: number, reason?: string): void;
  }

  class WebSocketServer {
    constructor(options: { port?: number; host?: string });
    on(event: "connection", listener: (socket: WebSocket, request: IncomingMessage) => void): this;
    on(event: "listening", listener: () => void): this;
    on(event: "error", listener: (err: Error) => void): this;
    address(): { port: number; address: string; family: string } | string | null;
    close(callback?: (err?: Error) => void): void;
  }

  export { WebSocket, WebSocketServer, RawData };
}
