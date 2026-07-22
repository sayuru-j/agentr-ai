import {
  extractBearerToken,
  safeEqualToken,
  safeParseRelayMessage,
  type ServerToWorker,
  type WorkerToServer,
} from "@agentr/shared";
import { createServer, type Server as HttpServer } from "node:http";
import { WebSocketServer, type WebSocket } from "ws";
import type { ServerConfig } from "./config.js";
import type { SessionStore } from "./store.js";

export type WorkerMessageHandler = (
  msg: WorkerToServer,
  socket: WebSocket,
) => void;

export class WorkerHub {
  private wss: WebSocketServer | null = null;
  private httpServer: HttpServer | null = null;
  private onMessage: WorkerMessageHandler | null = null;

  constructor(
    private readonly config: ServerConfig,
    private readonly store: SessionStore,
  ) {}

  setMessageHandler(handler: WorkerMessageHandler): void {
    this.onMessage = handler;
  }

  start(): HttpServer {
    this.httpServer = createServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end("AgentRelay WSS hub\n");
    });

    this.wss = new WebSocketServer({ server: this.httpServer, path: "/ws" });

    this.wss.on("connection", (socket, req) => {
      const token = extractBearerToken(req.headers.authorization);
      if (
        !this.config.workerToken ||
        !token ||
        !safeEqualToken(token, this.config.workerToken)
      ) {
        socket.close(4001, "unauthorized");
        return;
      }

      socket.on("message", (raw) => {
        let data: unknown;
        try {
          data = JSON.parse(String(raw));
        } catch {
          return;
        }
        const parsed = safeParseRelayMessage(data);
        if (!parsed.success) return;
        const msg = parsed.data as WorkerToServer;
        if (
          msg.type === "worker.hello" ||
          msg.type === "task.log" ||
          msg.type === "task.approval_request" ||
          msg.type === "task.status"
        ) {
          this.onMessage?.(msg, socket);
        }
      });

      socket.on("close", () => {
        this.store.clearWorker(socket);
      });
    });

    this.httpServer.listen(this.config.wsPort);
    return this.httpServer;
  }

  send(msg: ServerToWorker): boolean {
    const worker = this.store.getWorker();
    if (!worker || worker.socket.readyState !== worker.socket.OPEN) {
      return false;
    }
    worker.socket.send(JSON.stringify(msg));
    return true;
  }

  stop(): void {
    this.wss?.close();
    this.httpServer?.close();
  }
}
