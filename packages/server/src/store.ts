import type {
  CliDiagnosisSummary,
  ConversationRef,
  ProjectMeta,
  TaskStatus,
} from "@agentr/shared";
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
  rootActivityId?: string;
  exitCode?: number;
  flushedLogChars?: number;
  parentTaskId?: string;
  agentThreadId?: string;
  summary?: string;
}

export interface TaskHistoryEntry {
  taskId: string;
  threadId: string;
  prompt: string;
  projectAlias?: string;
  status: TaskStatus;
  exitCode?: number;
  summary?: string;
  agentThreadId?: string;
  createdAt: number;
  finishedAt?: number;
}

export interface WorkerConnection {
  socket: WebSocket;
  hostname: string;
  version: string;
  repos: string[];
  connectedAt: number;
  agentModel?: string;
  agentBackend?: "cursor" | "codex";
  sessionLocked?: boolean;
  queueDepth?: number;
  queueTaskIds?: string[];
  runningTaskId?: string;
  cliDiagnosis?: CliDiagnosisSummary;
  globalPrompts?: Record<string, string>;
  projectMeta?: ProjectMeta[];
  lastPongAt?: number;
}

interface PersistedSession {
  pairedUserIds: string[];
}

interface PersistedHistory {
  byConversation: Record<string, TaskHistoryEntry[]>;
}

const MAX_HISTORY_PER_CONVERSATION = 50;

export class SessionStore {
  pairedUserIds = new Set<string>();
  pairingCode: string = generatePairingCode();
  worker: WorkerConnection | null = null;
  workerDisconnectedAt: number | null = null;
  lastWorkerHostname: string | null = null;
  tasks = new Map<string, TaskRecord>();
  pendingApprovals = new Map<string, string>();
  activeTaskByConversation = new Map<string, string>();
  lastTaskByConversation = new Map<string, string>();
  private historyByConversation = new Map<string, TaskHistoryEntry[]>();

  constructor(
    private readonly persistPath?: string,
    private readonly historyPath?: string,
  ) {
    this.load();
    this.loadHistory();
  }

  rotatePairingCode(): string {
    this.pairingCode = generatePairingCode();
    return this.pairingCode;
  }

  isPaired(userId: string): boolean {
    return this.pairedUserIds.has(userId);
  }

  getPairedUserIds(): string[] {
    return [...this.pairedUserIds];
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
    const wasOffline = !this.worker;
    if (this.worker && this.worker.socket !== conn.socket) {
      try {
        this.worker.socket.close(4000, "replaced by new worker");
      } catch {
        /* ignore */
      }
    }
    this.worker = conn;
    this.workerDisconnectedAt = null;
    this.lastWorkerHostname = conn.hostname;
    conn.connectedAt = conn.connectedAt || Date.now();
    if (wasOffline) {
      (conn as WorkerConnection & { justConnected?: boolean }).justConnected = true;
    }
  }

  clearWorker(socket: WebSocket): void {
    if (this.worker?.socket === socket) {
      this.lastWorkerHostname = this.worker.hostname;
      this.workerDisconnectedAt = Date.now();
      this.worker = null;
    }
  }

  consumeWorkerJustConnected(): boolean {
    const w = this.worker as WorkerConnection & { justConnected?: boolean } | null;
    if (w?.justConnected) {
      delete w.justConnected;
      return true;
    }
    return false;
  }

  updateWorkerQueue(runningTaskId?: string, queuedTaskIds?: string[]): void {
    if (!this.worker) return;
    this.worker.runningTaskId = runningTaskId;
    this.worker.queueTaskIds = queuedTaskIds ?? [];
    this.worker.queueDepth =
      (runningTaskId ? 1 : 0) + (queuedTaskIds?.length ?? 0);
  }

  getWorker(): WorkerConnection | null {
    return this.worker;
  }

  createTask(
    partial: Omit<TaskRecord, "status" | "logs" | "artifacts" | "createdAt"> & {
      status?: TaskStatus;
    },
  ): TaskRecord {
    const record: TaskRecord = {
      ...partial,
      status: partial.status ?? "running",
      logs: [],
      artifacts: [],
      createdAt: Date.now(),
      flushedLogChars: 0,
    };
    this.tasks.set(record.taskId, record);
    if (partial.prompt !== "Desktop screenshots") {
      this.activeTaskByConversation.set(partial.threadId, record.taskId);
    }
    return record;
  }

  findRunningTaskForConversation(conversationId: string): TaskRecord | undefined {
    const id = this.activeTaskByConversation.get(conversationId);
    if (id) {
      const task = this.tasks.get(id);
      if (task?.status === "running" || task?.status === "queued") return task;
    }
    let latest: TaskRecord | undefined;
    for (const task of this.tasks.values()) {
      if (
        task.threadId === conversationId &&
        (task.status === "running" || task.status === "queued") &&
        task.prompt !== "Desktop screenshots"
      ) {
        if (!latest || task.createdAt > latest.createdAt) latest = task;
      }
    }
    return latest;
  }

  getLastTaskForConversation(conversationId: string): TaskRecord | undefined {
    const id = this.lastTaskByConversation.get(conversationId);
    if (id) {
      const task = this.tasks.get(id);
      if (task) return task;
    }
    let latest: TaskRecord | undefined;
    for (const task of this.tasks.values()) {
      if (
        task.threadId === conversationId &&
        task.prompt !== "Desktop screenshots" &&
        task.status !== "running" &&
        task.status !== "queued"
      ) {
        if (!latest || task.createdAt > latest.createdAt) latest = task;
      }
    }
    return latest;
  }

  getTaskHistory(conversationId: string, limit = 10): TaskHistoryEntry[] {
    const list = this.historyByConversation.get(conversationId) ?? [];
    return list.slice(0, Math.min(limit, MAX_HISTORY_PER_CONVERSATION));
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
    if (task.logs.length > 400) {
      task.logs.splice(0, task.logs.length - 400);
    }
    return task;
  }

  setStatus(
    taskId: string,
    status: TaskStatus,
    exitCode?: number,
    summary?: string,
    agentThreadId?: string,
  ): TaskRecord | undefined {
    const task = this.tasks.get(taskId);
    if (!task) return undefined;
    task.status = status;
    if (typeof exitCode === "number") task.exitCode = exitCode;
    if (summary) task.summary = summary;
    if (agentThreadId) task.agentThreadId = agentThreadId;

    if (status !== "running" && status !== "queued") {
      const active = this.activeTaskByConversation.get(task.threadId);
      if (active === taskId) {
        this.activeTaskByConversation.delete(task.threadId);
      }
      if (task.prompt !== "Desktop screenshots") {
        this.lastTaskByConversation.set(task.threadId, taskId);
        this.pushHistory(task);
      }
    }
    return task;
  }

  private pushHistory(task: TaskRecord): void {
    const entry: TaskHistoryEntry = {
      taskId: task.taskId,
      threadId: task.threadId,
      prompt: task.prompt,
      projectAlias: task.projectAlias,
      status: task.status,
      exitCode: task.exitCode,
      summary: task.summary,
      agentThreadId: task.agentThreadId,
      createdAt: task.createdAt,
      finishedAt: Date.now(),
    };
    const list = this.historyByConversation.get(task.threadId) ?? [];
    list.unshift(entry);
    if (list.length > MAX_HISTORY_PER_CONVERSATION) {
      list.length = MAX_HISTORY_PER_CONVERSATION;
    }
    this.historyByConversation.set(task.threadId, list);
    this.saveHistory();
  }

  resolvePromptTemplate(
    alias: string,
    name: string,
  ): string | undefined {
    const worker = this.worker;
    if (!worker) return undefined;
    const project = worker.projectMeta?.find((p) => p.alias === alias);
    if (project?.prompts?.[name]) return project.prompts[name];
    return worker.globalPrompts?.[name];
  }

  listPromptTemplates(): Array<{ alias?: string; name: string; text: string }> {
    const worker = this.worker;
    if (!worker) return [];
    const out: Array<{ alias?: string; name: string; text: string }> = [];
    if (worker.globalPrompts) {
      for (const [name, text] of Object.entries(worker.globalPrompts)) {
        out.push({ name, text });
      }
    }
    for (const pm of worker.projectMeta ?? []) {
      if (!pm.prompts) continue;
      for (const [name, text] of Object.entries(pm.prompts)) {
        out.push({ alias: pm.alias, name, text });
      }
    }
    return out;
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
      writeFileSync(this.persistPath, JSON.stringify(data, null, 2) + "\n");
    } catch (err) {
      console.warn("[store] failed to save session persistence", err);
    }
  }

  private loadHistory(): void {
    if (!this.historyPath || !existsSync(this.historyPath)) return;
    try {
      const raw = JSON.parse(
        readFileSync(this.historyPath, "utf8"),
      ) as PersistedHistory;
      if (raw.byConversation && typeof raw.byConversation === "object") {
        for (const [cid, entries] of Object.entries(raw.byConversation)) {
          if (Array.isArray(entries)) {
            this.historyByConversation.set(cid, entries);
          }
        }
      }
    } catch (err) {
      console.warn("[store] failed to load task history", err);
    }
  }

  private saveHistory(): void {
    if (!this.historyPath) return;
    try {
      mkdirSync(dirname(this.historyPath), { recursive: true });
      const byConversation: Record<string, TaskHistoryEntry[]> = {};
      for (const [cid, entries] of this.historyByConversation) {
        byConversation[cid] = entries;
      }
      writeFileSync(
        this.historyPath,
        JSON.stringify({ byConversation }, null, 2) + "\n",
      );
    } catch (err) {
      console.warn("[store] failed to save task history", err);
    }
  }
}

export function defaultSessionPath(dataDir: string): string {
  return join(dataDir, "session.json");
}

export function defaultHistoryPath(dataDir: string): string {
  return join(dataDir, "task-history.json");
}
