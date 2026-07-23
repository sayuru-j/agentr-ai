import {
  extractWorkerToken,
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

    this.wss = new WebSocketServer({
      server: this.httpServer,
      path: "/ws",
      maxPayload: 25 * 1024 * 1024,
    });

    this.wss.on("connection", (socket, req) => {
      const token = extractWorkerToken(req);
      const expected = this.config.workerToken.trim();
      if (!expected) {
        console.warn("[ws] WORKER_TOKEN is empty on server — rejecting worker");
        socket.close(4001, "unauthorized");
        return;
      }
      if (!token || !safeEqualToken(token, expected)) {
        console.warn(
          `[ws] worker unauthorized (token ${token ? "mismatch" : "missing"}, client sent ${token ? token.length : 0} chars, server expects ${expected.length})`,
        );
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
        // Forward all worker→server protocol messages
        if (
          msg.type === "worker.hello" ||
          msg.type === "worker.config" ||
          msg.type === "worker.pong" ||
          msg.type === "task.log" ||
          msg.type === "task.approval_request" ||
          msg.type === "task.status" ||
          msg.type === "task.artifact" ||
          msg.type === "file.result"
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
