import { z } from "zod";

export const TaskStatusSchema = z.enum([
  "running",
  "succeeded",
  "failed",
  "cancelled",
]);
export type TaskStatus = z.infer<typeof TaskStatusSchema>;

export const ConversationRefSchema = z.object({
  serviceUrl: z.string(),
  conversationId: z.string(),
  activityId: z.string().optional(),
  tenantId: z.string().optional(),
});
export type ConversationRef = z.infer<typeof ConversationRefSchema>;

/** Worker → Server: announce identity after connect */
export const WorkerHelloSchema = z.object({
  type: z.literal("worker.hello"),
  hostname: z.string(),
  version: z.string(),
  repos: z.array(z.string()),
  pairingCode: z.string().optional(),
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
});
export type TaskCreate = z.infer<typeof TaskCreateSchema>;

/** Server → Worker: capture all monitors now (no agent). */
export const ScreenshotCaptureSchema = z.object({
  type: z.literal("screenshot.capture"),
  requestId: z.string(),
  quality: z.enum(["preview", "hq"]),
});
export type ScreenshotCapture = z.infer<typeof ScreenshotCaptureSchema>;

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
});
export type TaskStatusMessage = z.infer<typeof TaskStatusMessageSchema>;

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
  ServerAckSchema,
]);
export type ServerToWorker = z.infer<typeof ServerToWorkerSchema>;

export const WorkerToServerSchema = z.discriminatedUnion("type", [
  WorkerHelloSchema,
  TaskLogSchema,
  TaskApprovalRequestSchema,
  TaskStatusMessageSchema,
  TaskArtifactSchema,
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
