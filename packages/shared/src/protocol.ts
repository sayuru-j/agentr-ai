import { z } from "zod";

export const TaskStatusSchema = z.enum([
  "queued",
  "running",
  "succeeded",
  "failed",
  "cancelled",
]);
export type TaskStatus = z.infer<typeof TaskStatusSchema>;

export const ResumeModeSchema = z.enum(["continue", "fresh"]);
export type ResumeMode = z.infer<typeof ResumeModeSchema>;

export const ConversationRefSchema = z.object({
  serviceUrl: z.string(),
  conversationId: z.string(),
  activityId: z.string().optional(),
  tenantId: z.string().optional(),
});
export type ConversationRef = z.infer<typeof ConversationRefSchema>;

export const TaskFileSchema = z.object({
  name: z.string().min(1).max(200),
  /** raw base64 (no data: prefix) */
  dataBase64: z.string().min(1),
  mimeType: z.string().optional(),
});
export type TaskFile = z.infer<typeof TaskFileSchema>;

export const ResumeContextSchema = z.object({
  parentTaskId: z.string(),
  agentThreadId: z.string().optional(),
  logSummary: z.string().optional(),
  priorPrompt: z.string().optional(),
});
export type ResumeContext = z.infer<typeof ResumeContextSchema>;

export const CliDiagnosisSummarySchema = z.object({
  ok: z.boolean(),
  version: z.string().optional(),
  errors: z.array(z.string()).optional(),
  warnings: z.array(z.string()).optional(),
});
export type CliDiagnosisSummary = z.infer<typeof CliDiagnosisSummarySchema>;

export const ProjectGuardrailsSchema = z.object({
  readOnly: z.boolean().optional(),
  requireApproval: z.boolean().optional(),
  maxRuntimeMinutes: z.number().optional(),
  denyPatterns: z.array(z.string()).optional(),
  allowPatterns: z.array(z.string()).optional(),
  blockWhenLocked: z.boolean().optional(),
});
export type ProjectGuardrails = z.infer<typeof ProjectGuardrailsSchema>;

export const ProjectMetaSchema = z.object({
  alias: z.string(),
  prompts: z.record(z.string()).optional(),
  guardrails: ProjectGuardrailsSchema.optional(),
});
export type ProjectMeta = z.infer<typeof ProjectMetaSchema>;

/** Worker → Server: announce identity after connect */
export const WorkerHelloSchema = z.object({
  type: z.literal("worker.hello"),
  hostname: z.string(),
  version: z.string(),
  repos: z.array(z.string()),
  pairingCode: z.string().optional(),
  agentModel: z.string().optional(),
  agentBackend: z.enum(["cursor", "codex"]).optional(),
  sessionLocked: z.boolean().optional(),
  queueDepth: z.number().int().nonnegative().optional(),
  queueTaskIds: z.array(z.string()).optional(),
  cliDiagnosis: CliDiagnosisSummarySchema.optional(),
  globalPrompts: z.record(z.string()).optional(),
  projectMeta: z.array(ProjectMetaSchema).optional(),
});
export type WorkerHello = z.infer<typeof WorkerHelloSchema>;

/** Server → Worker: create a task */
export const TaskCreateSchema = z.object({
  type: z.literal("task.create"),
  taskId: z.string(),
  prompt: z.string(),
  threadId: z.string(),
  projectAlias: z.string().optional(),
  conversation: ConversationRefSchema,
  /** Optional files to write into the project before the agent runs. */
  files: z.array(TaskFileSchema).max(8).optional(),
  /** Per-task model override (otherwise worker config). */
  agentModel: z.string().optional(),
  parentTaskId: z.string().optional(),
  resumeMode: ResumeModeSchema.optional(),
  resumeContext: ResumeContextSchema.optional(),
});
export type TaskCreate = z.infer<typeof TaskCreateSchema>;

/** Server → Worker: capture all monitors now (no agent). */
export const ScreenshotCaptureSchema = z.object({
  type: z.literal("screenshot.capture"),
  requestId: z.string(),
  quality: z.enum(["preview", "hq"]),
});
export type ScreenshotCapture = z.infer<typeof ScreenshotCaptureSchema>;

/** Server → Worker: update worker settings (e.g. model). */
export const WorkerSetConfigSchema = z.object({
  type: z.literal("worker.set_config"),
  agentModel: z.string().min(1).optional(),
});
export type WorkerSetConfig = z.infer<typeof WorkerSetConfigSchema>;

/** Server → Worker: health ping (latency + disk probe). */
export const WorkerPingSchema = z.object({
  type: z.literal("worker.ping"),
  requestId: z.string(),
  sentAt: z.number(),
});
export type WorkerPing = z.infer<typeof WorkerPingSchema>;

/** Worker → Server: streamed log chunk */
export const TaskLogSchema = z.object({
  type: z.literal("task.log"),
  taskId: z.string(),
  stream: z.enum(["stdout", "stderr"]),
  chunk: z.string(),
  ts: z.number(),
});
export type TaskLog = z.infer<typeof TaskLogSchema>;

/** Worker → Server: request phone approval before shell action */
export const TaskApprovalRequestSchema = z.object({
  type: z.literal("task.approval_request"),
  taskId: z.string(),
  approvalId: z.string(),
  command: z.string(),
  reason: z.string(),
  projectAlias: z.string().optional(),
  cwd: z.string().optional(),
  gitBranch: z.string().optional(),
  gitDirty: z.boolean().optional(),
  screenshotUrl: z.string().optional(),
});
export type TaskApprovalRequest = z.infer<typeof TaskApprovalRequestSchema>;

/** Server → Worker: approve or reject */
export const TaskApprovalResponseSchema = z.object({
  type: z.literal("task.approval_response"),
  taskId: z.string(),
  approvalId: z.string(),
  decision: z.enum(["approve", "reject"]),
});
export type TaskApprovalResponse = z.infer<typeof TaskApprovalResponseSchema>;

/** Worker → Server: task lifecycle status */
export const TaskStatusMessageSchema = z.object({
  type: z.literal("task.status"),
  taskId: z.string(),
  status: TaskStatusSchema,
  message: z.string().optional(),
  exitCode: z.number().optional(),
  queuePosition: z.number().int().positive().optional(),
  summary: z.string().optional(),
  agentThreadId: z.string().optional(),
});
export type TaskStatusMessage = z.infer<typeof TaskStatusMessageSchema>;

/** Worker → Server: queue snapshot */
export const WorkerQueueSchema = z.object({
  type: z.literal("worker.queue"),
  runningTaskId: z.string().optional(),
  queuedTaskIds: z.array(z.string()),
});
export type WorkerQueue = z.infer<typeof WorkerQueueSchema>;

/** Worker → Server: binary-ish artifact (screenshot) as base64 */
export const TaskArtifactSchema = z.object({
  type: z.literal("task.artifact"),
  taskId: z.string(),
  name: z.string(),
  mimeType: z.string(),
  /** raw base64 (no data: prefix) */
  dataBase64: z.string(),
  kind: z.literal("screenshot"),
  label: z.string().optional(),
});
export type TaskArtifact = z.infer<typeof TaskArtifactSchema>;

/** Worker → Server: confirm config after set_config / hello refresh */
export const WorkerConfigSchema = z.object({
  type: z.literal("worker.config"),
  agentModel: z.string(),
});
export type WorkerConfigMessage = z.infer<typeof WorkerConfigSchema>;

export const ProjectDiskSchema = z.object({
  alias: z.string(),
  path: z.string(),
  freeBytes: z.number().optional(),
  totalBytes: z.number().optional(),
  error: z.string().optional(),
});
export type ProjectDisk = z.infer<typeof ProjectDiskSchema>;

/** Worker → Server: health pong */
export const WorkerPongSchema = z.object({
  type: z.literal("worker.pong"),
  requestId: z.string(),
  sentAt: z.number(),
  projects: z.array(ProjectDiskSchema).optional(),
  sessionLocked: z.boolean().optional(),
  queueDepth: z.number().int().nonnegative().optional(),
  queueTaskIds: z.array(z.string()).optional(),
});
export type WorkerPong = z.infer<typeof WorkerPongSchema>;

/** Server → Worker: read a project file for Teams. */
export const FileGetSchema = z.object({
  type: z.literal("file.get"),
  requestId: z.string(),
  projectAlias: z.string().min(1),
  relativePath: z.string().min(1).max(500),
});
export type FileGet = z.infer<typeof FileGetSchema>;

/** Worker → Server: file.get result (inline text or base64 download). */
export const FileResultSchema = z.object({
  type: z.literal("file.result"),
  requestId: z.string(),
  ok: z.boolean(),
  error: z.string().optional(),
  name: z.string().optional(),
  relativePath: z.string().optional(),
  mimeType: z.string().optional(),
  sizeBytes: z.number().int().nonnegative().optional(),
  delivery: z.enum(["inline", "download"]).optional(),
  text: z.string().optional(),
  truncated: z.boolean().optional(),
  dataBase64: z.string().optional(),
});
export type FileResult = z.infer<typeof FileResultSchema>;

/** Server → Worker: cancel a running task */
export const TaskCancelSchema = z.object({
  type: z.literal("task.cancel"),
  taskId: z.string(),
});
export type TaskCancel = z.infer<typeof TaskCancelSchema>;

/** Server → Worker: ack hello / pairing code refresh */
export const ServerAckSchema = z.object({
  type: z.literal("server.ack"),
  message: z.string(),
  pairingCode: z.string().optional(),
  /** Number of Teams users currently paired (for tray checklist). */
  pairedUsers: z.number().int().nonnegative().optional(),
});
export type ServerAck = z.infer<typeof ServerAckSchema>;

export const ServerToWorkerSchema = z.discriminatedUnion("type", [
  TaskCreateSchema,
  ScreenshotCaptureSchema,
  TaskApprovalResponseSchema,
  TaskCancelSchema,
  WorkerSetConfigSchema,
  WorkerPingSchema,
  FileGetSchema,
  ServerAckSchema,
]);
export type ServerToWorker = z.infer<typeof ServerToWorkerSchema>;

export const WorkerToServerSchema = z.discriminatedUnion("type", [
  WorkerHelloSchema,
  TaskLogSchema,
  TaskApprovalRequestSchema,
  TaskStatusMessageSchema,
  TaskArtifactSchema,
  WorkerConfigSchema,
  WorkerPongSchema,
  FileResultSchema,
  WorkerQueueSchema,
]);
export type WorkerToServer = z.infer<typeof WorkerToServerSchema>;

export const RelayMessageSchema = z.union([
  ServerToWorkerSchema,
  WorkerToServerSchema,
]);
export type RelayMessage = z.infer<typeof RelayMessageSchema>;

export function parseRelayMessage(data: unknown): RelayMessage {
  return RelayMessageSchema.parse(data);
}

export function safeParseRelayMessage(data: unknown) {
  return RelayMessageSchema.safeParse(data);
}
