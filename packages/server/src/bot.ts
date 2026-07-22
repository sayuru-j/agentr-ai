import {
  parseProjectAlias,
  type TaskApprovalResponse,
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
import { buildApprovalCard, buildTaskCard } from "./cards.js";
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

export class AgentRelayBot {
  readonly adapter: CloudAdapter | null;
  private logUpdateTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private artifactTimers = new Map<string, ReturnType<typeof setTimeout>>();

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
      await context.sendActivity("AgentRelay hit an error processing that message.");
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
    // Strip Teams @bot mention so "@AgentR @sample …" still parses as @sample.
    TurnContext.removeRecipientMention(context.activity);
    const text = (context.activity.text ?? "")
      .replace(/<\/?at>/gi, "")
      .trim();
    if (!text) return;

    // Only respond to slash commands and @alias prompts — ignore normal chat.
    if (!text.startsWith("@") && !text.startsWith("/")) {
      return;
    }

    const userId = context.activity.from?.id ?? "";
    const lower = text.toLowerCase();

    if (lower.startsWith("/pair")) {
      const code = text.slice(5).trim();
      if (!code) {
        await context.sendActivity("Usage: `/pair <code>`");
        return;
      }
      if (this.store.pair(userId, code)) {
        await context.sendActivity(
          "Paired successfully. Send `@alias your prompt`, or `/ss` for a desktop screenshot. AgentR ignores normal chat.",
        );
      } else {
        await context.sendActivity(
          "Invalid pairing code. Check the code shown in the tray app / worker logs.",
        );
      }
      return;
    }

    if (lower === "/ss" || lower.startsWith("/ss ")) {
      if (!this.store.isPaired(userId)) {
        await context.sendActivity(
          "Not paired. Open the tray app for a pairing code, then send `/pair <code>`.",
        );
        return;
      }
      const worker = this.store.getWorker();
      if (!worker) {
        await context.sendActivity("Worker is offline. Start the tray app on your PC.");
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
      });

      const ok = this.hub.send({
        type: "screenshot.capture",
        requestId,
      });
      if (!ok) {
        await context.sendActivity("Worker disconnected — could not request screenshots.");
        return;
      }
      await context.sendActivity("Capturing desktop screenshots…");
      return;
    }

    if (lower === "/projects" || lower === "/status") {
      const worker = this.store.getWorker();
      if (!worker) {
        await context.sendActivity("No worker connected.");
        return;
      }
      const repos =
        worker.repos.length > 0 ? worker.repos.join(", ") : "(none configured)";
      await context.sendActivity(
        `Worker **${worker.hostname}** v${worker.version}\nProjects: ${repos}\nPaired: ${this.store.isPaired(userId) ? "yes" : "no"}`,
      );
      return;
    }

    if (lower === "/help") {
      await context.sendActivity(
        [
          "**AgentR** only replies to messages starting with `@` or `/`.",
          "",
          "**Commands**",
          "`/pair <code>` — link your Teams user to the worker",
          "`/projects` — list worker project aliases",
          "`/status` — worker connection status",
          "`/help` — this message",
          "`/ss` — capture current desktop (all monitors), no agent",
          "`@alias your prompt` — run a task on a project",
        ].join("\n"),
      );
      return;
    }

    if (!this.store.isPaired(userId)) {
      await context.sendActivity(
        "Not paired. Open the tray app for a pairing code, then send `/pair <code>`.",
      );
      return;
    }

    const worker = this.store.getWorker();
    if (!worker) {
      await context.sendActivity("Worker is offline. Start the tray app on your PC.");
      return;
    }

    const { alias, prompt } = parseProjectAlias(text);

    // Task prompts must use @alias.
    if (!alias) {
      await context.sendActivity(
        "Use `@alias your prompt`, or `/ss` for screenshots. Example: `@sample what's in this folder?`",
      );
      return;
    }

    if (!prompt) {
      await context.sendActivity(
        "Add a prompt after `@alias`, e.g. `@sample what's in this folder?`",
      );
      return;
    }

    const taskId = randomUUID();
    const conversation = {
      serviceUrl: context.activity.serviceUrl,
      conversationId: context.activity.conversation.id,
      activityId: context.activity.id,
      tenantId: context.activity.conversation.tenantId,
    };

    const record = this.store.createTask({
      taskId,
      threadId: context.activity.conversation.id,
      prompt,
      projectAlias: alias,
      conversation,
    });

    const card = buildTaskCard({
      taskId,
      prompt,
      status: "running",
      projectAlias: alias,
      logs: [],
      hostname: worker.hostname,
    });

    const reply = MessageFactory.attachment(CardFactory.adaptiveCard(card));
    const sent = await context.sendActivity(reply);
    if (sent?.id) {
      record.activityId = sent.id;
    }

    const ok = this.hub.send({
      type: "task.create",
      taskId,
      prompt,
      threadId: record.threadId,
      projectAlias: alias,
      conversation,
    });

    if (!ok) {
      this.store.setStatus(taskId, "failed");
      await this.updateTaskCard(record, "Worker disconnected while starting task.");
    }
  }

  async onWorkerHello(
    hostname: string,
    version: string,
    repos: string[],
    socket: import("ws").WebSocket,
    pairingCode?: string,
  ): Promise<void> {
    this.store.setWorker({
      socket,
      hostname,
      version,
      repos,
      connectedAt: Date.now(),
    });
    if (pairingCode) {
      this.store.pairingCode = pairingCode;
    }
    this.hub.send({
      type: "server.ack",
      message: "connected",
      pairingCode: this.store.pairingCode,
    });
    console.log(
      `[ws] worker hello ${hostname} v${version} repos=${repos.join(",") || "-"} pair=${this.store.pairingCode}`,
    );
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
        // Mark screenshot-only requests complete without a second image embed.
        if (task!.prompt === "Desktop screenshots") {
          this.store.setStatus(task!.taskId, "succeeded");
        }
      }, 200),
    );
  }

  private async sendScreenshotCard(task: TaskRecord): Promise<void> {
    if (task.artifacts.length === 0) return;

    // Adaptive Cards only show tiny non-expandable thumbs in many Teams clients.
    // Send native image attachments so users can open full-size screenshots.
    await this.sendToConversation(
      task,
      MessageFactory.text(
        `🖥 **Desktop screenshots** — ${task.artifacts.length} display${task.artifacts.length === 1 ? "" : "s"}`,
      ),
    );

    for (const shot of task.artifacts) {
      await this.sendToConversation(task, {
        type: "message",
        text: shot.label,
        attachments: [
          {
            contentType: shot.mimeType || "image/jpeg",
            contentUrl: shot.url,
            name: shot.name,
          },
        ],
      });
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
    );
  }

  async onTaskStatus(
    taskId: string,
    status: TaskRecord["status"],
    message?: string,
  ): Promise<void> {
    const task = this.store.setStatus(taskId, status);
    if (!task) return;
    if (message) task.logs.push(`\n[${status}] ${message}\n`);
    await this.updateTaskCard(task);
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
  ): Promise<void> {
    if (extraLog) task.logs.push(extraLog);
    const worker = this.store.getWorker();
    const card = buildTaskCard({
      taskId: task.taskId,
      prompt: task.prompt,
      status: task.status,
      projectAlias: task.projectAlias,
      logs: task.logs,
      hostname: worker?.hostname,
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

  private async sendToConversation(
    task: TaskRecord,
    activity: Partial<Activity>,
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
          await ctx.sendActivity(activity);
        },
      );
    } catch (err) {
      console.error("[bot] failed to send activity", err);
    }
  }
}
