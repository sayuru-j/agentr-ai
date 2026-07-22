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
import { captureAllDisplays } from "./screenshot.js";

export type WorkerStatus = "offline" | "connecting" | "online" | "busy";

export interface WorkerEvents {
  status: (status: WorkerStatus) => void;
  pairingCode: (code: string) => void;
  log: (line: string) => void;
  error: (err: Error) => void;
  /** Fired when the relay rejects the worker token (no auto-reconnect). */
  unauthorized: (message: string) => void;
  /** Task started on this PC — open local console. */
  taskStart: (info: {
    taskId: string;
    prompt: string;
    cwd: string;
  }) => void;
  /** Live agent output chunk for local console + relay. */
  taskLog: (info: {
    taskId: string;
    stream: "stdout" | "stderr";
    chunk: string;
  }) => void;
  /** Task finished. */
  taskEnd: (info: { taskId: string; exitCode: number }) => void;
}

type PendingApproval = {
  resolve: (approved: boolean) => void;
};

export class AgentRelayWorker {
  private ws: WebSocket | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;
  private authBlocked = false;
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
    this.authBlocked = false;
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
    if (this.stopped || this.authBlocked) return;
    const token = this.config.workerToken.trim();
    if (!token || token.includes("PASTE_")) {
      this.setStatus("offline");
      this.emit(
        "unauthorized",
        "Worker token missing or still a placeholder. Paste the token from the VM (config.env / cli:status → Show worker token), then Save & connect.",
      );
      return;
    }

    this.setStatus("connecting");
    this.emit("log", `Connecting to ${this.config.relayUrl}…`);

    // Put token in query as well — some proxies drop Authorization on WS upgrade
    let wsUrl = this.config.relayUrl;
    try {
      const u = new URL(this.config.relayUrl);
      u.searchParams.set("token", token);
      wsUrl = u.toString();
    } catch {
      const join = this.config.relayUrl.includes("?") ? "&" : "?";
      wsUrl = `${this.config.relayUrl}${join}token=${encodeURIComponent(token)}`;
    }

    const ws = new WebSocket(wsUrl, {
      headers: {
        Authorization: `Bearer ${token}`,
        "X-AgentR-Token": token,
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
      const why = reason.toString() || "";
      this.emit("log", `Disconnected (${code}) ${why}`.trim());
      this.ws = null;
      this.setStatus("offline");

      if (code === 4001) {
        this.authBlocked = true;
        if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
        this.emit(
          "unauthorized",
          "Relay rejected the worker token (unauthorized). Copy WORKER_TOKEN from the VM and Save & connect again.",
        );
        return;
      }

      this.scheduleReconnect();
    });

    ws.on("error", (err) => {
      this.emit("error", err instanceof Error ? err : new Error(String(err)));
    });
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.authBlocked) return;
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
    this.emit("taskStart", { taskId, prompt, cwd });

    const runner = new TaskRunner();
    this.runners.set(taskId, runner);

    const exitCode = await runner.run({
      taskId,
      prompt,
      cwd,
      agentCommand: this.config.agentCommand,
      agentModel: this.config.agentModel,
      dryRun: this.config.dryRun,
      onLog: (stream, chunk) => {
        this.emit("taskLog", { taskId, stream, chunk });
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
    this.emit("taskEnd", { taskId, exitCode: exitCode ?? 1 });

    // Let UI settle, then capture every monitor for Teams.
    if (!this.config.dryRun) {
      await this.sendDesktopScreenshots(taskId);
    }

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

  private async sendDesktopScreenshots(taskId: string): Promise<void> {
    try {
      // Brief pause so windows the agent opened can finish painting.
      await new Promise((r) => setTimeout(r, 1500));
      const screens = await captureAllDisplays();
      this.emit("log", `Captured ${screens.length} display screenshot(s)`);
      for (const screen of screens) {
        this.send({
          type: "task.artifact",
          taskId,
          name: screen.name,
          mimeType: screen.mimeType,
          dataBase64: screen.buffer.toString("base64"),
          kind: "screenshot",
          label: screen.label,
        });
        this.emit("taskLog", {
          taskId,
          stream: "stdout",
          chunk: `\n[screenshot] ${screen.label} (${screen.name})\n`,
        });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.emit("error", new Error(`Screenshot failed: ${message}`));
      this.send({
        type: "task.log",
        taskId,
        stream: "stderr",
        chunk: `\n[agent-relay] Screenshot capture failed: ${message}\n`,
        ts: Date.now(),
      });
    }
  }
}
