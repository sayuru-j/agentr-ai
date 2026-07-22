import type { ConversationRef, TaskStatus } from "@agentr/shared";
import { generatePairingCode } from "@agentr/shared";
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

export class SessionStore {
  pairedUserIds = new Set<string>();
  pairingCode: string = generatePairingCode();
  worker: WorkerConnection | null = null;
  tasks = new Map<string, TaskRecord>();
  /** approvalId → taskId */
  pendingApprovals = new Map<string, string>();

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
    return true;
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
    return record;
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
    // Keep last ~200 chunks to bound memory
    if (task.logs.length > 200) {
      task.logs.splice(0, task.logs.length - 200);
    }
    return task;
  }

  setStatus(taskId: string, status: TaskStatus): TaskRecord | undefined {
    const task = this.tasks.get(taskId);
    if (!task) return undefined;
    task.status = status;
    return task;
  }
}
