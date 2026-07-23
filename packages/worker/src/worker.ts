import {
  generatePairingCode,
  PROTOCOL_VERSION,
  safeParseRelayMessage,
  type ServerToWorker,
  type TaskFile,
  type WorkerToServer,
} from "@agentr/shared";
import { hostname as osHostname } from "node:os";
import WebSocket from "ws";
import type { WorkerConfig } from "./config.js";
import { saveWorkerConfig } from "./config.js";
import { writeTaskInboxFiles } from "./inbox.js";
import { preferResolvedAgentCommand } from "./resolve-agent.js";
import { prepareForScreenshot } from "./display.js";
import { projectPath, type ProjectEntry } from "./config.js";
import { probeProjectDisks } from "./disk.js";
import { readProjectFileForGet } from "./file-get.js";
import { newApprovalId, TaskRunner } from "./runner.js";
import { captureAllDisplays } from "./screenshot.js";
import { uploadScreenshotsHttps } from "./upload.js";

export type WorkerStatus = "offline" | "connecting" | "online" | "busy";

/** Human-facing connection state for the tray. */
export type ConnectionHint =
  | { kind: "ok"; detail?: string }
  | { kind: "connecting"; detail?: string }
  | {
      kind: "reconnecting";
      attempt: number;
      inMs: number;
      reason: string;
    }
  | { kind: "unauthorized"; message: string }
  | { kind: "re_pair"; message: string; pairingCode: string }
  | { kind: "offline"; reason: string };

export interface WorkerEvents {
  status: (status: WorkerStatus) => void;
  pairingCode: (code: string) => void;
  /** Teams users paired on the relay (from server.ack). */
  pairedUsers: (count: number) => void;
  /** Rich reconnect / re-pair messaging for the tray. */
  connection: (hint: ConnectionHint) => void;
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

type QueuedTask = {
  taskId: string;
  prompt: string;
  projectAlias?: string;
  files?: TaskFile[];
  agentModel?: string;
};

export class AgentRelayWorker {
  private ws: WebSocket | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;
  private authBlocked = false;
  private status: WorkerStatus = "offline";
  private pairingCode = generatePairingCode();
  private pairedUsers = 0;
  private wasOnline = false;
  private pairedBeforeDisconnect = 0;
  private reconnectAttempt = 0;
  private lastDisconnectReason = "";
  private runners = new Map<string, TaskRunner>();
  private pendingApprovals = new Map<string, PendingApproval>();
  private taskQueue: QueuedTask[] = [];
  private draining = false;
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

  getPairedUsers(): number {
    return this.pairedUsers;
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
    this.taskQueue = [];
    this.ws?.close();
    this.ws = null;
    this.setStatus("offline");
  }

  reconnect(): void {
    this.authBlocked = false;
    this.reconnectAttempt = 0;
    this.backoffMs = 1000;
    this.setConnection({ kind: "connecting", detail: "Manual reconnect…" });
    this.ws?.close();
    this.ws = null;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.connect();
  }

  getConnectionHint(): ConnectionHint {
    if (this.authBlocked) {
      return {
        kind: "unauthorized",
        message:
          "Relay rejected the worker token. Paste WORKER_TOKEN from the VM and Save & connect.",
      };
    }
    if (this.status === "connecting") {
      return { kind: "connecting", detail: "Dialing the relay…" };
    }
    if (this.status === "online" || this.status === "busy") {
      return { kind: "ok" };
    }
    if (this.reconnectTimer) {
      return {
        kind: "reconnecting",
        attempt: this.reconnectAttempt,
        inMs: this.backoffMs,
        reason: this.lastDisconnectReason || "Connection lost",
      };
    }
    return {
      kind: "offline",
      reason: this.lastDisconnectReason || "Not connected",
    };
  }

  private setConnection(hint: ConnectionHint): void {
    this.emit("connection", hint);
  }

  private classifyDisconnect(code: number, reason: string): string {
    if (code === 4001) return "Unauthorized (bad worker token)";
    if (code === 4000) return "Relay replaced this worker connection";
    if (code === 1001) return "Relay going away (restart?)";
    if (code === 1006) return "Relay closed unexpectedly (restart or network)";
    if (code === 1000) return "Clean disconnect";
    return reason || `Disconnected (code ${code})`;
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
    this.setConnection({ kind: "connecting", detail: "Dialing the relay…" });
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
      const recovered = this.wasOnline;
      this.backoffMs = 1000;
      this.reconnectAttempt = 0;
      this.setStatus(this.runners.size > 0 ? "busy" : "online");
      this.emit(
        "log",
        recovered
          ? "Reconnected to relay"
          : "Connected",
      );
      this.emit("pairingCode", this.pairingCode);
      this.setConnection({
        kind: "ok",
        detail: recovered ? "Reconnected after relay drop" : undefined,
      });
      this.send({
        type: "worker.hello",
        hostname: osHostname(),
        version: PROTOCOL_VERSION,
        repos: Object.keys(this.config.projects),
        pairingCode: this.pairingCode,
        agentModel: this.config.agentModel || "auto",
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
      this.lastDisconnectReason = this.classifyDisconnect(code, why);
      this.pairedBeforeDisconnect = this.pairedUsers;
      this.wasOnline =
        this.wasOnline || this.status === "online" || this.status === "busy";
      this.emit("log", `Disconnected (${code}) ${this.lastDisconnectReason}`);
      this.ws = null;
      this.setStatus("offline");

      if (code === 4001) {
        this.authBlocked = true;
        if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
        const message =
          "Relay rejected the worker token (unauthorized). Copy WORKER_TOKEN from the VM and Save & connect again.";
        this.setConnection({ kind: "unauthorized", message });
        this.emit("unauthorized", message);
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
    this.reconnectAttempt += 1;
    const wait = this.backoffMs;
    this.backoffMs = Math.min(this.backoffMs * 2, 30_000);
    this.emit(
      "log",
      `${this.lastDisconnectReason} — reconnecting in ${Math.round(wait / 1000)}s (attempt ${this.reconnectAttempt})…`,
    );
    this.setConnection({
      kind: "reconnecting",
      attempt: this.reconnectAttempt,
      inMs: wait,
      reason: this.lastDisconnectReason || "Connection lost",
    });
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
        if (typeof msg.pairedUsers === "number") {
          const prev = this.pairedUsers;
          this.pairedUsers = msg.pairedUsers;
          this.emit("pairedUsers", this.pairedUsers);
          if (
            this.wasOnline &&
            this.pairedBeforeDisconnect > 0 &&
            msg.pairedUsers === 0 &&
            prev === 0
          ) {
            this.setConnection({
              kind: "re_pair",
              pairingCode: this.pairingCode,
              message:
                "Relay has no paired Teams users. Send /pair with the code from the tray.",
            });
          } else if (msg.message === "connected" || msg.message === "pairing-updated") {
            if (msg.pairedUsers > 0 || !this.wasOnline) {
              this.setConnection({ kind: "ok" });
            }
          }
        }
        this.wasOnline = true;
        this.emit("log", `Server ack: ${msg.message}`);
        break;
      case "worker.ping":
        this.send({
          type: "worker.pong",
          requestId: msg.requestId,
          sentAt: msg.sentAt,
          projects: probeProjectDisks(this.config.projects),
        });
        break;
      case "task.create":
        this.enqueueTask({
          taskId: msg.taskId,
          prompt: msg.prompt,
          projectAlias: msg.projectAlias,
          files: msg.files,
          agentModel: msg.agentModel,
        });
        break;
      case "worker.set_config":
        if (msg.agentModel?.trim()) {
          this.config.agentModel = msg.agentModel.trim();
          try {
            saveWorkerConfig(this.config);
          } catch (err) {
            this.emit(
              "error",
              err instanceof Error ? err : new Error(String(err)),
            );
          }
          this.send({
            type: "worker.config",
            agentModel: this.config.agentModel,
          });
          this.emit("log", `Model set to ${this.config.agentModel}`);
        }
        break;
      case "screenshot.capture":
        await this.handleScreenshotCapture(
          msg.requestId,
          msg.quality === "hq" ? "hq" : "preview",
        );
        break;
      case "file.get":
        this.handleFileGet(msg.requestId, msg.projectAlias, msg.relativePath);
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
        const qi = this.taskQueue.findIndex((t) => t.taskId === msg.taskId);
        if (qi >= 0) {
          this.taskQueue.splice(qi, 1);
          this.send({
            type: "task.status",
            taskId: msg.taskId,
            status: "cancelled",
            message: "Cancelled while queued",
          });
          this.reannounceQueue();
          break;
        }
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

  private enqueueTask(task: QueuedTask): void {
    this.taskQueue.push(task);
    const busy = this.draining || this.runners.size > 0;
    if (busy) {
      this.send({
        type: "task.status",
        taskId: task.taskId,
        status: "queued",
        message: `Queued (#${this.taskQueue.length})`,
        queuePosition: this.taskQueue.length,
      });
      this.setStatus("busy");
    }
    void this.drainQueue();
  }

  private reannounceQueue(): void {
    this.taskQueue.forEach((t, i) => {
      this.send({
        type: "task.status",
        taskId: t.taskId,
        status: "queued",
        message: `Queued (#${i + 1})`,
        queuePosition: i + 1,
      });
    });
  }

  private async drainQueue(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    try {
      while (this.taskQueue.length > 0 && !this.stopped) {
        const next = this.taskQueue.shift();
        if (!next) break;
        this.reannounceQueue();
        await this.runTask(next);
      }
    } finally {
      this.draining = false;
      if (this.taskQueue.length > 0 && !this.stopped) {
        void this.drainQueue();
      } else if (this.ws && this.runners.size === 0) {
        this.setStatus("online");
      }
    }
  }

  private resolveProject(projectAlias?: string): ProjectEntry | null {
    if (!projectAlias) {
      const first = Object.values(this.config.projects)[0];
      return first ?? { path: process.cwd() };
    }
    return this.config.projects[projectAlias] ?? null;
  }

  private async runTask(task: QueuedTask): Promise<void> {
    const { taskId, projectAlias, files, agentModel } = task;
    let { prompt } = task;
    const project = this.resolveProject(projectAlias);
    const cwd = project ? projectPath(project) : null;
    if (!cwd) {
      this.send({
        type: "task.status",
        taskId,
        status: "failed",
        message: `Unknown project alias: ${projectAlias}`,
      });
      return;
    }

    if (files && files.length > 0) {
      try {
        const { dir, paths } = writeTaskInboxFiles(cwd, files);
        const names = paths.map((p) => p.slice(dir.length + 1));
        prompt = `Files saved under \`.agentr-inbox/\`:\n${names.map((n) => `- ${n}`).join("\n")}\n\n${prompt}`;
        this.emit("log", `Wrote ${paths.length} file(s) → ${dir}`);
      } catch (err) {
        this.send({
          type: "task.status",
          taskId,
          status: "failed",
          message: `Failed to save attachments: ${err instanceof Error ? err.message : String(err)}`,
        });
        return;
      }
    }

    const model =
      (agentModel ||
        project?.agentModel ||
        this.config.agentModel ||
        "auto"
      ).trim() || "auto";
    const dryRun =
      typeof project?.dryRun === "boolean"
        ? project.dryRun
        : this.config.dryRun;

    this.setStatus("busy");
    this.send({ type: "task.status", taskId, status: "running" });
    this.emit("taskStart", { taskId, prompt, cwd });

    const runner = new TaskRunner();
    this.runners.set(taskId, runner);

    const exitCode = await runner.run({
      taskId,
      prompt,
      cwd,
      agentCommand: preferResolvedAgentCommand(this.config.agentCommand),
      agentModel: model,
      dryRun,
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
    this.emit("taskEnd", { taskId, exitCode: exitCode ?? 1 });

    this.send({
      type: "task.status",
      taskId,
      status:
        exitCode === 0
          ? "succeeded"
          : exitCode === 130
            ? "cancelled"
            : "failed",
      exitCode: exitCode ?? 1,
      message:
        exitCode === 0
          ? "Completed"
          : exitCode === 130
            ? "Cancelled"
            : `Exited with code ${exitCode}`,
    });

    if (this.ws && this.taskQueue.length === 0 && this.runners.size === 0) {
      this.setStatus("online");
    }
  }

  private async handleScreenshotCapture(
    requestId: string,
    quality: "preview" | "hq",
  ): Promise<void> {
    this.setStatus("busy");
    try {
      const display = await prepareForScreenshot();
      if (display.locked) {
        throw new Error(
          display.detail ||
            "Windows session is locked. Unlock the PC, then retry /ss.",
        );
      }
      if (display.woke) {
        this.emit("log", `Screenshot prep: ${display.detail || "woke displays"}`);
      }
      const screens = await captureAllDisplays(quality);
      this.emit(
        "log",
        `Screenshot ${quality} ${requestId.slice(0, 8)} — ${screens.length} display(s)`,
      );
      const result = await uploadScreenshotsHttps({
        relayUrl: this.config.relayUrl,
        workerToken: this.config.workerToken,
        taskId: requestId,
        screenshots: screens.map((s) => ({
          name: s.name,
          mimeType: s.mimeType,
          label: s.label,
          buffer: s.buffer,
        })),
        tlsInsecure: this.config.tlsInsecure,
      });
      if (!result.ok) {
        throw new Error(result.error || "upload failed");
      }
      this.emit("log", "Screenshot upload complete");
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.emit("error", new Error(`Screenshot failed: ${message}`));
    } finally {
      this.setStatus(this.ws ? "online" : "offline");
    }
  }

  private handleFileGet(
    requestId: string,
    projectAlias: string,
    relativePath: string,
  ): void {
    const project = this.config.projects[projectAlias];
    if (!project) {
      this.send({
        type: "file.result",
        requestId,
        ok: false,
        error: `Unknown project \`${projectAlias}\``,
      });
      return;
    }
    const root = projectPath(project);
    if (!root) {
      this.send({
        type: "file.result",
        requestId,
        ok: false,
        error: "Project path is empty",
      });
      return;
    }
    const result = readProjectFileForGet(root, relativePath);
    if (!result.ok) {
      this.send({
        type: "file.result",
        requestId,
        ok: false,
        error: result.error,
      });
      return;
    }
    this.emit(
      "log",
      `file.get ${projectAlias}:${result.relativePath} (${result.delivery}, ${result.sizeBytes} B)`,
    );
    if (result.delivery === "inline") {
      this.send({
        type: "file.result",
        requestId,
        ok: true,
        name: result.name,
        relativePath: result.relativePath,
        mimeType: result.mimeType,
        sizeBytes: result.sizeBytes,
        delivery: "inline",
        text: result.text,
        truncated: result.truncated,
      });
      return;
    }
    this.send({
      type: "file.result",
      requestId,
      ok: true,
      name: result.name,
      relativePath: result.relativePath,
      mimeType: result.mimeType,
      sizeBytes: result.sizeBytes,
      delivery: "download",
      dataBase64: result.dataBase64,
    });
  }
}
