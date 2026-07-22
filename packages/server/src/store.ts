import type { ConversationRef, TaskStatus } from "@agentr/shared";
import { generatePairingCode } from "@agentr/shared";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import type { WebSocket } from "ws";

export interface TaskArtifactMeta {
  name: string;
  mimeType: string;
  label: string;
  url: string;
}

export interface TaskRecord {
  taskId: string;
  threadId: string;
  prompt: string;
  projectAlias?: string;
  conversation: ConversationRef;
  status: TaskStatus;
  logs: string[];
  artifacts: TaskArtifactMeta[];
  createdAt: number;
  activityId?: string;
}

export interface WorkerConnection {
  socket: WebSocket;
  hostname: string;
  version: string;
  repos: string[];
  connectedAt: number;
}

interface PersistedSession {
  pairedUserIds: string[];
}

export class SessionStore {
  pairedUserIds = new Set<string>();
  pairingCode: string = generatePairingCode();
  worker: WorkerConnection | null = null;
  tasks = new Map<string, TaskRecord>();
  /** approvalId → taskId */
  pendingApprovals = new Map<string, string>();
  /** conversationId → latest agent taskId (for /cancel) */
  activeTaskByConversation = new Map<string, string>();

  constructor(private readonly persistPath?: string) {
    this.load();
  }

  rotatePairingCode(): string {
    this.pairingCode = generatePairingCode();
    return this.pairingCode;
  }

  isPaired(userId: string): boolean {
    return this.pairedUserIds.has(userId);
  }

  pair(userId: string, code: string): boolean {
    const expected = this.pairingCode.replace(/-/g, "").toUpperCase();
    const given = code.replace(/-/g, "").toUpperCase();
    if (expected !== given) return false;
    this.pairedUserIds.add(userId);
    this.rotatePairingCode();
    this.save();
    return true;
  }

  unpair(userId: string): boolean {
    const removed = this.pairedUserIds.delete(userId);
    if (removed) this.save();
    return removed;
  }

  setWorker(conn: WorkerConnection): void {
    if (this.worker && this.worker.socket !== conn.socket) {
      try {
        this.worker.socket.close(4000, "replaced by new worker");
      } catch {
        /* ignore */
      }
    }
    this.worker = conn;
  }

  clearWorker(socket: WebSocket): void {
    if (this.worker?.socket === socket) {
      this.worker = null;
    }
  }

  getWorker(): WorkerConnection | null {
    return this.worker;
  }

  createTask(
    partial: Omit<TaskRecord, "status" | "logs" | "artifacts" | "createdAt">,
  ): TaskRecord {
    const record: TaskRecord = {
      ...partial,
      status: "running",
      logs: [],
      artifacts: [],
      createdAt: Date.now(),
    };
    this.tasks.set(record.taskId, record);
    // Track agent tasks for /cancel (not screenshot-only requests).
    if (partial.prompt !== "Desktop screenshots") {
      this.activeTaskByConversation.set(partial.threadId, record.taskId);
    }
    return record;
  }

  findRunningTaskForConversation(conversationId: string): TaskRecord | undefined {
    const id = this.activeTaskByConversation.get(conversationId);
    if (id) {
      const task = this.tasks.get(id);
      if (task?.status === "running") return task;
    }
    // Fallback: latest running task in this conversation
    let latest: TaskRecord | undefined;
    for (const task of this.tasks.values()) {
      if (
        task.threadId === conversationId &&
        task.status === "running" &&
        task.prompt !== "Desktop screenshots"
      ) {
        if (!latest || task.createdAt > latest.createdAt) latest = task;
      }
    }
    return latest;
  }

  addArtifact(taskId: string, artifact: TaskArtifactMeta): TaskRecord | undefined {
    const task = this.tasks.get(taskId);
    if (!task) return undefined;
    task.artifacts.push(artifact);
    return task;
  }

  appendLog(taskId: string, chunk: string): TaskRecord | undefined {
    const task = this.tasks.get(taskId);
    if (!task) return undefined;
    task.logs.push(chunk);
    if (task.logs.length > 200) {
      task.logs.splice(0, task.logs.length - 200);
    }
    return task;
  }

  setStatus(taskId: string, status: TaskStatus): TaskRecord | undefined {
    const task = this.tasks.get(taskId);
    if (!task) return undefined;
    task.status = status;
    if (status !== "running") {
      const active = this.activeTaskByConversation.get(task.threadId);
      if (active === taskId) {
        this.activeTaskByConversation.delete(task.threadId);
      }
    }
    return task;
  }

  private load(): void {
    if (!this.persistPath || !existsSync(this.persistPath)) return;
    try {
      const raw = JSON.parse(
        readFileSync(this.persistPath, "utf8"),
      ) as PersistedSession;
      if (Array.isArray(raw.pairedUserIds)) {
        this.pairedUserIds = new Set(
          raw.pairedUserIds.filter((id) => typeof id === "string" && id),
        );
      }
    } catch (err) {
      console.warn("[store] failed to load session persistence", err);
    }
  }

  private save(): void {
    if (!this.persistPath) return;
    try {
      mkdirSync(dirname(this.persistPath), { recursive: true });
      const data: PersistedSession = {
        pairedUserIds: [...this.pairedUserIds],
      };
      writeFileSync(this.persistPath, JSON.stringify(data, null, 2) + "\n", "utf8");
    } catch (err) {
      console.warn("[store] failed to save session persistence", err);
    }
  }
}

export function defaultSessionPath(dataDir: string): string {
  return join(dataDir, "session.json");
}
