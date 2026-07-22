import {
  generatePairingCode,
  PROTOCOL_VERSION,
  safeParseRelayMessage,
  type ServerToWorker,
  type WorkerToServer,
} from "@agentr/shared";
import { hostname as osHostname } from "node:os";
import WebSocket from "ws";
import type { WorkerConfig } from "./config.js";
import { newApprovalId, TaskRunner } from "./runner.js";

export type WorkerStatus = "offline" | "connecting" | "online" | "busy";

export interface WorkerEvents {
  status: (status: WorkerStatus) => void;
  pairingCode: (code: string) => void;
  log: (line: string) => void;
  error: (err: Error) => void;
}

type PendingApproval = {
  resolve: (approved: boolean) => void;
};

export class AgentRelayWorker {
  private ws: WebSocket | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;
  private status: WorkerStatus = "offline";
  private pairingCode = generatePairingCode();
  private runners = new Map<string, TaskRunner>();
  private pendingApprovals = new Map<string, PendingApproval>();
  private backoffMs = 1000;
  private listeners: {
    [K in keyof WorkerEvents]?: Set<WorkerEvents[K]>;
  } = {};

  constructor(private config: WorkerConfig) {}

  on<K extends keyof WorkerEvents>(event: K, fn: WorkerEvents[K]): () => void {
    if (!this.listeners[event]) {
      this.listeners[event] = new Set() as never;
    }
    (this.listeners[event] as Set<WorkerEvents[K]>).add(fn);
    return () => {
      (this.listeners[event] as Set<WorkerEvents[K]>).delete(fn);
    };
  }

  private emit<K extends keyof WorkerEvents>(
    event: K,
    ...args: Parameters<WorkerEvents[K]>
  ): void {
    const set = this.listeners[event] as Set<WorkerEvents[K]> | undefined;
    if (!set) return;
    for (const fn of set) {
      (fn as (...a: Parameters<WorkerEvents[K]>) => void)(...args);
    }
  }

  getPairingCode(): string {
    return this.pairingCode;
  }

  getStatus(): WorkerStatus {
    return this.status;
  }

  updateConfig(config: WorkerConfig): void {
    this.config = config;
  }

  start(): void {
    this.stopped = false;
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    for (const runner of this.runners.values()) runner.cancel();
    this.runners.clear();
    this.ws?.close();
    this.ws = null;
    this.setStatus("offline");
  }

  reconnect(): void {
    this.ws?.close();
    this.ws = null;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.backoffMs = 1000;
    this.connect();
  }

  private setStatus(status: WorkerStatus): void {
    this.status = status;
    this.emit("status", status);
  }

  private connect(): void {
    if (this.stopped) return;
    this.setStatus("connecting");
    this.emit("log", `Connecting to ${this.config.relayUrl}…`);

    const ws = new WebSocket(this.config.relayUrl, {
      headers: {
        Authorization: `Bearer ${this.config.workerToken}`,
      },
      rejectUnauthorized: !this.config.tlsInsecure,
    });
    this.ws = ws;

    ws.on("open", () => {
      this.backoffMs = 1000;
      this.setStatus(this.runners.size > 0 ? "busy" : "online");
      this.emit("log", "Connected");
      this.emit("pairingCode", this.pairingCode);
      this.send({
        type: "worker.hello",
        hostname: osHostname(),
        version: PROTOCOL_VERSION,
        repos: Object.keys(this.config.projects),
        pairingCode: this.pairingCode,
      });
    });

    ws.on("message", (raw) => {
      let data: unknown;
      try {
        data = JSON.parse(String(raw));
      } catch {
        return;
      }
      const parsed = safeParseRelayMessage(data);
      if (!parsed.success) return;
      const msg = parsed.data as ServerToWorker;
      void this.handleServerMessage(msg);
    });

    ws.on("close", (code, reason) => {
      this.emit(
        "log",
        `Disconnected (${code}) ${reason.toString() || ""}`.trim(),
      );
      this.ws = null;
      this.setStatus("offline");
      this.scheduleReconnect();
    });

    ws.on("error", (err) => {
      this.emit("error", err instanceof Error ? err : new Error(String(err)));
    });
  }

  private scheduleReconnect(): void {
    if (this.stopped) return;
    const wait = this.backoffMs;
    this.backoffMs = Math.min(this.backoffMs * 2, 30_000);
    this.emit("log", `Reconnecting in ${Math.round(wait / 1000)}s…`);
    this.reconnectTimer = setTimeout(() => this.connect(), wait);
  }

  private send(msg: WorkerToServer): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    this.ws.send(JSON.stringify(msg));
  }

  private async handleServerMessage(msg: ServerToWorker): Promise<void> {
    switch (msg.type) {
      case "server.ack":
        if (msg.pairingCode) {
          this.pairingCode = msg.pairingCode;
          this.emit("pairingCode", this.pairingCode);
        }
        this.emit("log", `Server ack: ${msg.message}`);
        break;
      case "task.create":
        await this.runTask(msg.taskId, msg.prompt, msg.projectAlias);
        break;
      case "task.approval_response": {
        const pending = this.pendingApprovals.get(msg.approvalId);
        if (pending) {
          this.pendingApprovals.delete(msg.approvalId);
          pending.resolve(msg.decision === "approve");
        }
        break;
      }
      case "task.cancel": {
        const runner = this.runners.get(msg.taskId);
        if (runner) {
          runner.cancel();
          this.send({
            type: "task.status",
            taskId: msg.taskId,
            status: "cancelled",
            message: "Cancelled by server",
          });
        }
        break;
      }
    }
  }

  private resolveCwd(projectAlias?: string): string | null {
    if (!projectAlias) {
      const first = Object.values(this.config.projects)[0];
      return first ?? process.cwd();
    }
    const path = this.config.projects[projectAlias];
    if (!path) return null;
    return path;
  }

  private async runTask(
    taskId: string,
    prompt: string,
    projectAlias?: string,
  ): Promise<void> {
    const cwd = this.resolveCwd(projectAlias);
    if (!cwd) {
      this.send({
        type: "task.status",
        taskId,
        status: "failed",
        message: `Unknown project alias: ${projectAlias}`,
      });
      return;
    }

    this.setStatus("busy");
    this.send({ type: "task.status", taskId, status: "running" });

    const runner = new TaskRunner();
    this.runners.set(taskId, runner);

    const exitCode = await runner.run({
      taskId,
      prompt,
      cwd,
      agentCommand: this.config.agentCommand,
      dryRun: this.config.dryRun,
      onLog: (stream, chunk) => {
        this.send({
          type: "task.log",
          taskId,
          stream,
          chunk,
          ts: Date.now(),
        });
      },
      requestApproval: (command, reason) => {
        const approvalId = newApprovalId();
        this.send({
          type: "task.approval_request",
          taskId,
          approvalId,
          command,
          reason,
        });
        return new Promise<boolean>((resolve) => {
          this.pendingApprovals.set(approvalId, { resolve });
          // Auto-reject after 10 minutes
          setTimeout(() => {
            if (this.pendingApprovals.has(approvalId)) {
              this.pendingApprovals.delete(approvalId);
              resolve(false);
            }
          }, 10 * 60 * 1000);
        });
      },
    });

    this.runners.delete(taskId);
    this.setStatus(this.ws ? "online" : "offline");

    this.send({
      type: "task.status",
      taskId,
      status: exitCode === 0 ? "succeeded" : exitCode === 130 ? "cancelled" : "failed",
      exitCode: exitCode ?? 1,
      message:
        exitCode === 0
          ? "Completed"
          : exitCode === 130
            ? "Cancelled"
            : `Exited with code ${exitCode}`,
    });
  }
}
