import {
  parseProjectAlias,
  type FileResult,
  type ProjectDisk,
  type TaskApprovalResponse,
  type TaskFile,
  type TaskStatus,
} from "@agentr/shared";
import {
  CardFactory,
  CloudAdapter,
  ConfigurationBotFrameworkAuthentication,
  ConfigurationServiceClientCredentialFactory,
  MessageFactory,
  TurnContext,
  type Activity,
} from "botbuilder";
import { randomUUID } from "node:crypto";
import { downloadActivityFiles } from "./attachments.js";
import {
  buildApprovalCard,
  buildFileGetCard,
  buildHelpCard,
  buildLastTaskCard,
  buildProjectsCard,
  buildStatusCard,
  buildTaskCard,
} from "./cards.js";
import type { ServerConfig } from "./config.js";
import type { ArtifactStore } from "./artifacts.js";
import type { SessionStore, TaskRecord } from "./store.js";
import type { WorkerHub } from "./ws-hub.js";

type ApprovalPayload = {
  action?: string;
  decision?: "approve" | "reject";
  taskId?: string;
  approvalId?: string;
};

type PendingPong = {
  resolve: (value: { latencyMs: number; projects: ProjectDisk[] }) => void;
  timer: ReturnType<typeof setTimeout>;
};

type PendingFileGet = {
  alias: string;
  relativePath: string;
  conversation: {
    serviceUrl: string;
    conversationId: string;
    activityId?: string;
    tenantId?: string;
  };
  rootActivityId?: string;
  timer: ReturnType<typeof setTimeout>;
};

/** Flush log thread replies when card buffer grows past this many new chars. */
const THREAD_LOG_CHUNK = 2200;

function formatBytes(n: number | undefined): string {
  if (n === undefined || !Number.isFinite(n)) return "?";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v < 10 && i > 0 ? v.toFixed(1) : Math.round(v)} ${units[i]}`;
}

export class AgentRelayBot {
  readonly adapter: CloudAdapter | null;
  private logUpdateTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private artifactTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private pendingPongs = new Map<string, PendingPong>();
  private pendingFileGets = new Map<string, PendingFileGet>();

  constructor(
    private readonly config: ServerConfig,
    private readonly store: SessionStore,
    private readonly hub: WorkerHub,
    private readonly artifacts: ArtifactStore,
  ) {
    if (config.mockMode) {
      this.adapter = null;
      return;
    }

    const credentials = new ConfigurationServiceClientCredentialFactory({
      MicrosoftAppId: config.microsoftAppId,
      MicrosoftAppPassword: config.microsoftAppPassword,
      MicrosoftAppType: config.microsoftAppTenantId ? "SingleTenant" : "MultiTenant",
      MicrosoftAppTenantId: config.microsoftAppTenantId || undefined,
    });

    const auth = new ConfigurationBotFrameworkAuthentication(
      {},
      credentials,
    );
    this.adapter = new CloudAdapter(auth);
    this.adapter.onTurnError = async (context, error) => {
      console.error("[bot] turn error", error);
      await context.sendActivity("AgentR hit an error processing that message.");
    };
  }

  async handleTurn(context: TurnContext): Promise<void> {
    if (context.activity.type === "message") {
      const value = context.activity.value as ApprovalPayload | undefined;
      if (value?.action === "approval") {
        await this.handleApproval(context, value);
        return;
      }
      await this.handleMessage(context);
    }
  }

  private async handleApproval(
    context: TurnContext,
    value: ApprovalPayload,
  ): Promise<void> {
    if (!value.taskId || !value.approvalId || !value.decision) {
      await context.sendActivity("Invalid approval payload.");
      return;
    }

    const userId = context.activity.from?.id ?? "";
    if (!this.store.isPaired(userId)) {
      await context.sendActivity("You are not paired. Send `/pair <code>` first.");
      return;
    }

    const msg: TaskApprovalResponse = {
      type: "task.approval_response",
      taskId: value.taskId,
      approvalId: value.approvalId,
      decision: value.decision,
    };
    const ok = this.hub.send(msg);
    this.store.pendingApprovals.delete(value.approvalId);
    await context.sendActivity(
      ok
        ? `Sent **${value.decision}** to worker.`
        : "Worker is offline — approval was not delivered.",
    );
  }

  private async handleMessage(context: TurnContext): Promise<void> {
    TurnContext.removeRecipientMention(context.activity);
    const text = (context.activity.text ?? "")
      .replace(/<\/?at>/gi, "")
      .trim();

    const hasFiles = (context.activity.attachments ?? []).some(
      (a) => a.contentUrl && !(a.contentType ?? "").toLowerCase().includes("card"),
    );

    // Only respond to slash commands and !alias prompts (or !alias with files).
    if (!text.startsWith("!") && !text.startsWith("/")) {
      return;
    }

    const userId = context.activity.from?.id ?? "";
    const lower = text.toLowerCase();

    if (lower.startsWith("/pair")) {
      const code = text.slice(5).trim();
      if (!code) {
        await context.sendActivity("Usage: `/pair <code>` — copy the code from the AgentR tray.");
        return;
      }
      if (this.store.pair(userId, code)) {
        await context.sendActivity(
          "Paired. Use `!alias your prompt`, `!alias /get path`, `/projects`, `/model`, `/ss`, or `/sshq`.",
        );
        this.notifyWorkerPairing();
      } else {
        await context.sendActivity("Invalid pairing code. Check the AgentR tray and try again.");
      }
      return;
    }

    if (lower === "/unpair") {
      if (this.store.unpair(userId)) {
        await context.sendActivity("Unpaired.");
        this.notifyWorkerPairing();
      } else {
        await context.sendActivity("You were not paired.");
      }
      return;
    }

    if (lower === "/help") {
      await context.sendActivity(
        MessageFactory.attachment(CardFactory.adaptiveCard(buildHelpCard())),
      );
      return;
    }

    if (lower === "/whoami") {
      const worker = this.store.getWorker();
      const shortId = userId.length > 12 ? `${userId.slice(0, 8)}…` : userId;
      await context.sendActivity(
        MessageFactory.attachment(
          CardFactory.adaptiveCard(
            buildStatusCard({
              paired: this.store.isPaired(userId),
              workerOnline: Boolean(worker),
              hostname: worker?.hostname,
              version: worker?.version,
              projects: worker?.repos ?? [],
              agentModel: worker?.agentModel,
            }),
          ),
        ),
      );
      await context.sendActivity(`User id: \`${shortId}\``);
      return;
    }

    if (lower === "/status") {
      await this.handleStatusCommand(context, userId);
      return;
    }

    if (lower === "/projects") {
      const worker = this.store.getWorker();
      if (!worker) {
        await context.sendActivity("Worker is offline. Start the AgentR tray on your PC.");
        return;
      }
      await context.sendActivity(
        MessageFactory.attachment(
          CardFactory.adaptiveCard(
            buildProjectsCard({
              projects: worker.repos,
              hostname: worker.hostname,
            }),
          ),
        ),
      );
      return;
    }

    if (lower === "/last" || lower.startsWith("/last ")) {
      if (!this.store.isPaired(userId)) {
        await context.sendActivity("Not paired. Send `/pair <code>` first.");
        return;
      }
      const last = this.store.getLastTaskForConversation(
        context.activity.conversation.id,
      );
      if (!last) {
        await context.sendActivity("No previous agent task in this chat.");
        return;
      }
      await context.sendActivity(
        MessageFactory.attachment(
          CardFactory.adaptiveCard(
            buildLastTaskCard({
              taskId: last.taskId,
              prompt: last.prompt,
              status: last.status,
              projectAlias: last.projectAlias,
              exitCode: last.exitCode,
              logs: last.logs,
              createdAt: last.createdAt,
            }),
          ),
        ),
      );
      return;
    }

    if (lower === "/model" || lower.startsWith("/model ")) {
      await this.handleModelCommand(context, userId, text);
      return;
    }

    if (lower === "/sshq" || lower.startsWith("/sshq ")) {
      await this.handleScreenshotCommand(context, userId, "hq");
      return;
    }

    if (lower === "/ss" || lower.startsWith("/ss ")) {
      await this.handleScreenshotCommand(context, userId, "preview");
      return;
    }

    if (lower === "/cancel") {
      if (!this.store.isPaired(userId)) {
        await context.sendActivity("Not paired. Send `/pair <code>` first.");
        return;
      }
      const conversationId = context.activity.conversation.id;
      const task = this.store.findRunningTaskForConversation(conversationId);
      if (!task) {
        await context.sendActivity("No running or queued task to cancel.");
        return;
      }
      const ok = this.hub.send({ type: "task.cancel", taskId: task.taskId });
      await context.sendActivity(
        ok ? "Cancelled." : "Worker is offline — cancel was not delivered.",
      );
      return;
    }

    if (!this.store.isPaired(userId)) {
      await context.sendActivity("Not paired. Send `/pair <code>` from the AgentR tray.");
      return;
    }

    const worker = this.store.getWorker();
    if (!worker) {
      await context.sendActivity("Worker is offline. Start the AgentR tray on your PC.");
      return;
    }

    if (!text.startsWith("!")) {
      await context.sendActivity(
        "Unknown command. Send `/help`, or run a task with `!alias your prompt`.",
      );
      return;
    }

    const { alias, prompt } = parseProjectAlias(text);
    if (!alias) {
      await context.sendActivity(
        "Use `!alias your prompt`. Example: `!sample what's in this folder?`",
      );
      return;
    }

    const getMatch = prompt.match(/^\/get(?:\s+([\s\S]+))?$/i);
    if (getMatch) {
      await this.handleFileGetCommand(context, userId, alias, (getMatch[1] ?? "").trim());
      return;
    }

    let files: TaskFile[] = [];
    if (hasFiles) {
      const downloaded = await downloadActivityFiles({
        attachments: context.activity.attachments,
        appId: this.config.microsoftAppId,
        appPassword: this.config.microsoftAppPassword,
        tenantId: this.config.microsoftAppTenantId,
      });
      files = downloaded.files;
      if (downloaded.errors.length) {
        await context.sendActivity(
          `Attachment note: ${downloaded.errors.join("; ")}`,
        );
      }
    }

    const effectivePrompt =
      prompt ||
      (files.length > 0
        ? "Review the files saved under `.agentr-inbox/` and summarize what to do next."
        : "");

    if (!effectivePrompt) {
      await context.sendActivity(
        "Add a prompt after the alias, or attach files. Example: `!sample what's in this folder?`",
      );
      return;
    }

    if (alias && worker.repos.length > 0 && !worker.repos.includes(alias)) {
      await context.sendActivity(
        `Unknown project \`${alias}\`. Known: ${worker.repos.map((r) => `\`!${r}\``).join(", ") || "(none)"}`,
      );
      return;
    }

    await this.startAgentTask(context, {
      alias,
      prompt: effectivePrompt,
      files,
      hostname: worker.hostname,
    });
  }

  private async handleStatusCommand(
    context: TurnContext,
    userId: string,
  ): Promise<void> {
    const worker = this.store.getWorker();
    const last = this.store.getLastTaskForConversation(
      context.activity.conversation.id,
    );
    let latencyMs: number | null | undefined;
    let disks:
      | Array<{
          alias: string;
          freeLabel: string;
          totalLabel?: string;
          error?: string;
        }>
      | undefined;

    if (worker) {
      const health = await this.probeWorkerHealth(2500);
      if (health) {
        latencyMs = health.latencyMs;
        disks = health.projects.map((p) => ({
          alias: p.alias,
          freeLabel: formatBytes(p.freeBytes),
          totalLabel: formatBytes(p.totalBytes),
          error: p.error,
        }));
      } else {
        latencyMs = null;
      }
    }

    await context.sendActivity(
      MessageFactory.attachment(
        CardFactory.adaptiveCard(
          buildStatusCard({
            paired: this.store.isPaired(userId),
            workerOnline: Boolean(worker),
            hostname: worker?.hostname,
            version: worker?.version,
            projects: worker?.repos ?? [],
            agentModel: worker?.agentModel,
            latencyMs,
            lastTask: last
              ? {
                  status: last.status,
                  prompt: last.prompt,
                  projectAlias: last.projectAlias,
                  exitCode: last.exitCode,
                  createdAt: last.createdAt,
                }
              : null,
            disks,
          }),
        ),
      ),
    );
  }

  /** Round-trip ping the worker for latency + project disk free space. */
  private probeWorkerHealth(
    timeoutMs: number,
  ): Promise<{ latencyMs: number; projects: ProjectDisk[] } | null> {
    const requestId = randomUUID();
    const sentAt = Date.now();
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pendingPongs.delete(requestId);
        resolve(null);
      }, timeoutMs);
      this.pendingPongs.set(requestId, {
        timer,
        resolve: (value) => resolve(value),
      });
      const ok = this.hub.send({
        type: "worker.ping",
        requestId,
        sentAt,
      });
      if (!ok) {
        clearTimeout(timer);
        this.pendingPongs.delete(requestId);
        resolve(null);
      }
    });
  }

  onWorkerPong(
    requestId: string,
    sentAt: number,
    projects?: ProjectDisk[],
  ): void {
    const pending = this.pendingPongs.get(requestId);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pendingPongs.delete(requestId);
    pending.resolve({
      latencyMs: Math.max(0, Date.now() - sentAt),
      projects: projects ?? [],
    });
  }

  private async handleFileGetCommand(
    context: TurnContext,
    userId: string,
    alias: string,
    relativePath: string,
  ): Promise<void> {
    if (!this.store.isPaired(userId)) {
      await context.sendActivity("Not paired. Send `/pair <code>` first.");
      return;
    }
    const worker = this.store.getWorker();
    if (!worker) {
      await context.sendActivity(
        "Worker is offline. Start the AgentR tray on your PC.",
      );
      return;
    }
    if (worker.repos.length > 0 && !worker.repos.includes(alias)) {
      await context.sendActivity(
        `Unknown project \`${alias}\`. Known: ${worker.repos.map((r) => `\`!${r}\``).join(", ") || "(none)"}`,
      );
      return;
    }
    if (!relativePath) {
      await context.sendActivity(
        "Usage: `!alias /get path/to/file` — example: `!sample /get README.md`",
      );
      return;
    }

    const requestId = randomUUID();
    const conversation = {
      serviceUrl: context.activity.serviceUrl,
      conversationId: context.activity.conversation.id,
      activityId: context.activity.id,
      tenantId: context.activity.conversation.tenantId,
    };

    const timer = setTimeout(() => {
      const pending = this.pendingFileGets.get(requestId);
      if (!pending) return;
      this.pendingFileGets.delete(requestId);
      void this.replyInConversation(
        pending.conversation,
        pending.rootActivityId,
        `Timed out fetching \`${pending.relativePath}\` from \`!${pending.alias}\`.`,
      );
    }, 20_000);

    this.pendingFileGets.set(requestId, {
      alias,
      relativePath,
      conversation,
      rootActivityId: context.activity.id,
      timer,
    });

    const ok = this.hub.send({
      type: "file.get",
      requestId,
      projectAlias: alias,
      relativePath,
    });
    if (!ok) {
      clearTimeout(timer);
      this.pendingFileGets.delete(requestId);
      await context.sendActivity(
        "Worker disconnected — could not fetch the file.",
      );
      return;
    }

    const ack = MessageFactory.text(
      `Fetching \`!${alias}\` \`${relativePath}\`…`,
    );
    if (context.activity.id) ack.replyToId = context.activity.id;
    await context.sendActivity(ack);
  }

  async onFileResult(msg: FileResult): Promise<void> {
    const pending = this.pendingFileGets.get(msg.requestId);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pendingFileGets.delete(msg.requestId);

    if (!msg.ok) {
      await this.replyInConversation(
        pending.conversation,
        pending.rootActivityId,
        `Could not fetch \`${pending.relativePath}\`: ${msg.error || "unknown error"}`,
      );
      return;
    }

    const sizeLabel = formatBytes(msg.sizeBytes);
    const pathLabel = msg.relativePath || pending.relativePath;

    if (msg.delivery === "inline" && msg.text != null) {
      const isMarkdown = /\.md$/i.test(pathLabel);
      const body = msg.truncated
        ? `${msg.text}\n\n_(truncated — file exceeds inline size limit)_`
        : msg.text;
      const header = `**\`!${pending.alias}\`** \`${pathLabel}\` (${sizeLabel})`;
      const text = isMarkdown
        ? `${header}\n\n${body}`
        : `${header}\n\n\`\`\`\n${body}\n\`\`\``;
      await this.replyInConversation(
        pending.conversation,
        pending.rootActivityId,
        text,
      );
      return;
    }

    if (msg.delivery === "download" && msg.dataBase64) {
      const stored = this.artifacts.save({
        taskId: msg.requestId,
        name: msg.name || pathLabel.split("/").pop() || "file.bin",
        mimeType: msg.mimeType || "application/octet-stream",
        dataBase64: msg.dataBase64,
        label: pathLabel,
      });
      if (!this.adapter) {
        console.log(`[mock] file.get ${pathLabel} → ${stored.url}`);
        return;
      }
      try {
        const ref = {
          conversation: { id: pending.conversation.conversationId },
          serviceUrl: pending.conversation.serviceUrl,
        };
        await this.adapter.continueConversationAsync(
          this.config.microsoftAppId,
          ref as never,
          async (ctx) => {
            const card = MessageFactory.attachment(
              CardFactory.adaptiveCard(
                buildFileGetCard({
                  alias: pending.alias,
                  relativePath: pathLabel,
                  sizeLabel,
                  url: stored.url,
                  mimeType: stored.mimeType,
                }),
              ),
            );
            if (pending.rootActivityId) card.replyToId = pending.rootActivityId;
            await ctx.sendActivity(card);
          },
        );
      } catch (err) {
        console.error("[bot] file.get card failed", err);
      }
      return;
    }

    await this.replyInConversation(
      pending.conversation,
      pending.rootActivityId,
      `Fetched \`${pathLabel}\` but had nothing to display.`,
    );
  }

  private async replyInConversation(
    conversation: PendingFileGet["conversation"],
    rootActivityId: string | undefined,
    text: string,
  ): Promise<void> {
    if (!this.adapter) {
      console.log(`[mock] ${text}`);
      return;
    }
    try {
      const ref = {
        conversation: { id: conversation.conversationId },
        serviceUrl: conversation.serviceUrl,
      };
      await this.adapter.continueConversationAsync(
        this.config.microsoftAppId,
        ref as never,
        async (ctx) => {
          const activity = MessageFactory.text(text);
          if (rootActivityId) activity.replyToId = rootActivityId;
          await ctx.sendActivity(activity);
        },
      );
    } catch (err) {
      console.error("[bot] file.get reply failed", err);
    }
  }

  private async handleModelCommand(
    context: TurnContext,
    userId: string,
    text: string,
  ): Promise<void> {
    if (!this.store.isPaired(userId)) {
      await context.sendActivity("Not paired. Send `/pair <code>` first.");
      return;
    }
    const worker = this.store.getWorker();
    if (!worker) {
      await context.sendActivity("Worker is offline. Start the AgentR tray on your PC.");
      return;
    }

    const arg = text.slice("/model".length).trim();
    if (!arg) {
      await context.sendActivity(
        `Current model: \`${worker.agentModel || "auto"}\`.\nSet with \`/model auto\` or \`/model <name>\`.`,
      );
      return;
    }

    const ok = this.hub.send({
      type: "worker.set_config",
      agentModel: arg,
    });
    if (!ok) {
      await context.sendActivity("Worker disconnected — could not set model.");
      return;
    }
    worker.agentModel = arg;
    await context.sendActivity(`Model set to \`${arg}\` on **${worker.hostname}**.`);
  }

  private async startAgentTask(
    context: TurnContext,
    opts: {
      alias: string;
      prompt: string;
      files: TaskFile[];
      hostname: string;
    },
  ): Promise<void> {
    const taskId = randomUUID();
    const rootActivityId = context.activity.id;
    const conversation = {
      serviceUrl: context.activity.serviceUrl,
      conversationId: context.activity.conversation.id,
      activityId: rootActivityId,
      tenantId: context.activity.conversation.tenantId,
    };

    const record = this.store.createTask({
      taskId,
      threadId: context.activity.conversation.id,
      prompt: opts.prompt,
      projectAlias: opts.alias,
      conversation,
      rootActivityId,
      status: "queued",
    });

    const card = buildTaskCard({
      taskId,
      prompt: opts.prompt,
      status: "queued",
      projectAlias: opts.alias,
      logs: opts.files.length
        ? [`[agentr] ${opts.files.length} file(s) will be saved to .agentr-inbox/\n`]
        : [],
      hostname: opts.hostname,
    });

    const reply = MessageFactory.attachment(CardFactory.adaptiveCard(card));
    if (rootActivityId) {
      reply.replyToId = rootActivityId;
    }
    const sent = await context.sendActivity(reply);
    if (sent?.id) {
      record.activityId = sent.id;
    }

    const worker = this.store.getWorker();
    const ok = this.hub.send({
      type: "task.create",
      taskId,
      prompt: opts.prompt,
      threadId: record.threadId,
      projectAlias: opts.alias,
      conversation,
      files: opts.files.length ? opts.files : undefined,
      agentModel: worker?.agentModel,
    });

    if (!ok) {
      this.store.setStatus(taskId, "failed");
      await this.updateTaskCard(record, "Worker disconnected while starting task.");
    }
  }

  private async handleScreenshotCommand(
    context: TurnContext,
    userId: string,
    quality: "preview" | "hq",
  ): Promise<void> {
    if (!this.store.isPaired(userId)) {
      await context.sendActivity("Not paired. Send `/pair <code>` first.");
      return;
    }
    const worker = this.store.getWorker();
    if (!worker) {
      await context.sendActivity("Worker is offline. Start the AgentR tray on your PC.");
      return;
    }

    const requestId = randomUUID();
    const conversation = {
      serviceUrl: context.activity.serviceUrl,
      conversationId: context.activity.conversation.id,
      activityId: context.activity.id,
      tenantId: context.activity.conversation.tenantId,
    };
    this.store.createTask({
      taskId: requestId,
      threadId: conversation.conversationId,
      prompt: "Desktop screenshots",
      conversation,
      rootActivityId: context.activity.id,
    });

    const ok = this.hub.send({
      type: "screenshot.capture",
      requestId,
      quality,
    });
    if (!ok) {
      await context.sendActivity("Worker disconnected — could not request screenshots.");
      return;
    }
    const ack = MessageFactory.text(
      quality === "hq"
        ? "Capturing high-quality screenshots…"
        : "Capturing preview screenshots…",
    );
    if (context.activity.id) ack.replyToId = context.activity.id;
    await context.sendActivity(ack);
  }

  async onWorkerHello(
    hostname: string,
    version: string,
    repos: string[],
    socket: import("ws").WebSocket,
    pairingCode?: string,
    agentModel?: string,
  ): Promise<void> {
    this.store.setWorker({
      socket,
      hostname,
      version,
      repos,
      connectedAt: Date.now(),
      agentModel: agentModel || "auto",
    });
    if (pairingCode) {
      this.store.pairingCode = pairingCode;
    }
    this.hub.send({
      type: "server.ack",
      message: "connected",
      pairingCode: this.store.pairingCode,
      pairedUsers: this.store.pairedUserIds.size,
    });
    console.log(
      `[ws] worker hello ${hostname} v${version} model=${agentModel || "auto"} repos=${repos.join(",") || "-"} pair=${this.store.pairingCode}`,
    );
  }

  onWorkerConfig(agentModel: string): void {
    const worker = this.store.getWorker();
    if (worker) worker.agentModel = agentModel;
  }

  /** Push paired-user count to the worker for tray checklist. */
  private notifyWorkerPairing(): void {
    this.hub.send({
      type: "server.ack",
      message: "pairing-updated",
      pairingCode: this.store.pairingCode,
      pairedUsers: this.store.pairedUserIds.size,
    });
  }

  async onTaskLog(taskId: string, chunk: string): Promise<void> {
    const task = this.store.appendLog(taskId, chunk);
    if (!task) return;
    this.scheduleCardUpdate(task);
  }

  async onTaskArtifact(msg: {
    taskId: string;
    name: string;
    mimeType: string;
    dataBase64: string;
    label?: string;
  }): Promise<void> {
    const stored = this.artifacts.save({
      taskId: msg.taskId,
      name: msg.name,
      mimeType: msg.mimeType,
      dataBase64: msg.dataBase64,
      label: msg.label,
    });
    await this.onScreenshotsUploaded(msg.taskId, [
      { name: stored.name, label: stored.label, url: stored.url },
    ]);
  }

  /** HTTPS upload finished — post one screenshot card (not also embed in task card). */
  async onScreenshotsUploaded(
    taskId: string,
    shots: Array<{ name: string; label: string; url: string }>,
  ): Promise<void> {
    let task = this.store.tasks.get(taskId);
    if (!task) return;
    for (const shot of shots) {
      task = this.store.addArtifact(taskId, {
        name: shot.name,
        mimeType: "image/jpeg",
        label: shot.label,
        url: shot.url,
      });
    }
    if (!task) return;

    const existing = this.artifactTimers.get(task.taskId);
    if (existing) clearTimeout(existing);
    this.artifactTimers.set(
      task.taskId,
      setTimeout(() => {
        this.artifactTimers.delete(task.taskId);
        void this.sendScreenshotCard(task!);
        if (task!.prompt === "Desktop screenshots") {
          this.store.setStatus(task!.taskId, "succeeded");
        }
      }, 200),
    );
  }

  private async sendScreenshotCard(task: TaskRecord): Promise<void> {
    if (task.artifacts.length === 0) return;

    await this.sendToConversation(
      task,
      MessageFactory.text(
        `**Desktop screenshots** — ${task.artifacts.length} display${task.artifacts.length === 1 ? "" : "s"}`,
      ),
      true,
    );

    for (const shot of task.artifacts) {
      await this.sendToConversation(
        task,
        {
          type: "message",
          text: shot.label,
          attachments: [
            {
              contentType: shot.mimeType || "image/jpeg",
              contentUrl: shot.url,
              name: shot.name,
            },
          ],
        },
        true,
      );
    }
  }

  async onApprovalRequest(
    taskId: string,
    approvalId: string,
    command: string,
    reason: string,
  ): Promise<void> {
    const task = this.store.tasks.get(taskId);
    if (!task) return;
    this.store.pendingApprovals.set(approvalId, taskId);

    const card = buildApprovalCard({ taskId, approvalId, command, reason });
    await this.sendToConversation(
      task,
      MessageFactory.attachment(CardFactory.adaptiveCard(card)),
      true,
    );
  }

  async onTaskStatus(
    taskId: string,
    status: TaskStatus,
    message?: string,
    exitCode?: number,
    queuePosition?: number,
  ): Promise<void> {
    const task = this.store.setStatus(taskId, status, exitCode);
    if (!task) return;
    if (message) task.logs.push(`\n[${status}] ${message}\n`);
    await this.updateTaskCard(task, undefined, queuePosition);
  }

  private scheduleCardUpdate(task: TaskRecord): void {
    const existing = this.logUpdateTimers.get(task.taskId);
    if (existing) clearTimeout(existing);
    this.logUpdateTimers.set(
      task.taskId,
      setTimeout(() => {
        this.logUpdateTimers.delete(task.taskId);
        void this.updateTaskCard(task);
      }, 280),
    );
  }

  private async updateTaskCard(
    task: TaskRecord,
    extraLog?: string,
    queuePosition?: number,
  ): Promise<void> {
    if (extraLog) task.logs.push(extraLog);
    await this.flushLogThread(task);

    const worker = this.store.getWorker();
    const card = buildTaskCard({
      taskId: task.taskId,
      prompt: task.prompt,
      status: task.status,
      projectAlias: task.projectAlias,
      logs: task.logs,
      hostname: worker?.hostname,
      exitCode: task.exitCode,
      queuePosition,
    });

    if (!this.adapter || !task.activityId) {
      console.log(
        `[mock] task ${task.taskId.slice(0, 8)} ${task.status} logs=${task.logs.length}`,
      );
      return;
    }

    try {
      const ref = {
        activityId: task.activityId,
        conversation: { id: task.conversation.conversationId },
        serviceUrl: task.conversation.serviceUrl,
      };
      await this.adapter.continueConversationAsync(
        this.config.microsoftAppId,
        ref as never,
        async (ctx) => {
          const activity: Partial<Activity> = {
            type: "message",
            id: task.activityId,
            attachments: [CardFactory.adaptiveCard(card)],
          };
          await ctx.updateActivity(activity as Activity);
        },
      );
    } catch (err) {
      console.error("[bot] failed to update card", err);
    }
  }

  /** Post overflow logs as replies under the task card. */
  private async flushLogThread(task: TaskRecord): Promise<void> {
    const full = task.logs.join("");
    const flushed = task.flushedLogChars ?? 0;
    if (full.length - flushed < THREAD_LOG_CHUNK) return;

    // Leave a tail on the card; post the older overflow as a thread reply.
    const keepTail = 1200;
    const cutAt = Math.max(flushed, full.length - keepTail);
    if (cutAt <= flushed) return;

    const chunk = full.slice(flushed, cutAt).trim();
    task.flushedLogChars = cutAt;
    if (!chunk) return;

    const body =
      chunk.length > 3500 ? `…\n${chunk.slice(-3500)}` : chunk;
    await this.sendToConversation(
      task,
      MessageFactory.text(`\`\`\`\n${body}\n\`\`\``),
      true,
    );
  }

  private async sendToConversation(
    task: TaskRecord,
    activity: Partial<Activity>,
    asThreadReply = false,
  ): Promise<void> {
    if (!this.adapter) {
      console.log("[mock] would send activity", activity);
      return;
    }
    try {
      const ref = {
        conversation: { id: task.conversation.conversationId },
        serviceUrl: task.conversation.serviceUrl,
      };
      await this.adapter.continueConversationAsync(
        this.config.microsoftAppId,
        ref as never,
        async (ctx) => {
          if (asThreadReply) {
            const replyTo = task.activityId || task.rootActivityId;
            if (replyTo) activity.replyToId = replyTo;
          }
          await ctx.sendActivity(activity);
        },
      );
    } catch (err) {
      console.error("[bot] failed to send activity", err);
    }
  }
}
