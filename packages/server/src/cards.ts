import type { TaskStatus } from "@agentr/shared";

/** Adaptive Cards in Teams only support a Markdown subset — soften full .md. */
function toTeamsMarkdown(raw: string): string {
  let text = raw.replace(/\r\n/g, "\n").trimEnd();
  if (!text.trim()) return "_Waiting for worker output…_";

  // Headers → bold lines (Teams AC doesn't render # headings)
  text = text.replace(/^#{1,6}\s+(.+)$/gm, "**$1**");

  // Keep length bounded for Adaptive Card updates
  if (text.length > 3500) {
    text = "…\n" + text.slice(-3500);
  }

  return text;
}

export function buildTaskCard(opts: {
  taskId: string;
  prompt: string;
  status: TaskStatus;
  projectAlias?: string;
  logs: string[];
  hostname?: string;
  screenshots?: Array<{ url: string; label: string }>;
}) {
  const logText =
    opts.logs.length === 0
      ? "_Waiting for worker output…_"
      : toTeamsMarkdown(opts.logs.join(""));

  const statusEmoji: Record<TaskStatus, string> = {
    running: "⏳",
    succeeded: "✅",
    failed: "❌",
    cancelled: "🛑",
  };

  const body: Record<string, unknown>[] = [
    {
      type: "TextBlock",
      text: `${statusEmoji[opts.status]} AgentR Task`,
      weight: "Bolder",
      size: "Medium",
    },
    {
      type: "FactSet",
      facts: [
        { title: "Status", value: opts.status },
        { title: "Task", value: opts.taskId.slice(0, 8) },
        ...(opts.projectAlias
          ? [{ title: "Project", value: opts.projectAlias }]
          : []),
        ...(opts.hostname
          ? [{ title: "Worker", value: opts.hostname }]
          : []),
      ],
    },
    {
      type: "TextBlock",
      text: opts.prompt,
      wrap: true,
      weight: "Bolder",
    },
    {
      type: "TextBlock",
      text: logText,
      wrap: true,
      size: "Small",
    },
  ];

  if (opts.screenshots && opts.screenshots.length > 0) {
    body.push({
      type: "TextBlock",
      text: "**Desktop screenshots**",
      weight: "Bolder",
      spacing: "Medium",
    });
    for (const shot of opts.screenshots) {
      body.push({
        type: "TextBlock",
        text: shot.label,
        size: "Small",
        isSubtle: true,
        spacing: "Small",
      });
      body.push({
        type: "Image",
        url: shot.url,
        altText: shot.label,
        size: "Stretch",
      });
    }
  }

  return {
    type: "AdaptiveCard",
    $schema: "http://adaptivecards.io/schemas/adaptive-card.json",
    version: "1.4",
    body,
  };
}

export function buildScreenshotCard(opts: {
  taskId: string;
  screenshots: Array<{ url: string; label: string }>;
}) {
  const body: Record<string, unknown>[] = [
    {
      type: "TextBlock",
      text: "🖥 Desktop screenshots",
      weight: "Bolder",
      size: "Medium",
    },
    {
      type: "TextBlock",
      text: `Task ${opts.taskId.slice(0, 8)} — all monitors`,
      isSubtle: true,
      spacing: "None",
    },
  ];
  for (const shot of opts.screenshots) {
    body.push({
      type: "TextBlock",
      text: shot.label,
      weight: "Bolder",
      spacing: "Medium",
    });
    body.push({
      type: "Image",
      url: shot.url,
      altText: shot.label,
      size: "Stretch",
    });
  }
  return {
    type: "AdaptiveCard",
    $schema: "http://adaptivecards.io/schemas/adaptive-card.json",
    version: "1.4",
    body,
  };
}

export function buildHelpCard() {
  return {
    type: "AdaptiveCard",
    $schema: "http://adaptivecards.io/schemas/adaptive-card.json",
    version: "1.4",
    body: [
      {
        type: "TextBlock",
        text: "AgentR commands",
        weight: "Bolder",
        size: "Medium",
      },
      {
        type: "TextBlock",
        text: "Only messages starting with `!` or `/` are handled. Normal chat is ignored.",
        wrap: true,
        isSubtle: true,
      },
      {
        type: "FactSet",
        facts: [
          { title: "/pair", value: "`/pair <code>` — link this Teams user" },
          { title: "/unpair", value: "Disconnect this Teams user" },
          { title: "/whoami", value: "Show pairing and worker identity" },
          { title: "/projects", value: "List project aliases" },
          { title: "/status", value: "Worker connection status" },
          { title: "/ss", value: "Preview screenshots (all monitors)" },
          { title: "/sshq", value: "High-quality screenshots (all monitors)" },
          { title: "/cancel", value: "Cancel the running agent task" },
          { title: "/help", value: "This help card" },
          {
            title: "Task",
            value: "`!alias your prompt` — e.g. `!sample fix the bug`",
          },
        ],
      },
    ],
  };
}

export function buildStatusCard(opts: {
  paired: boolean;
  workerOnline: boolean;
  hostname?: string;
  version?: string;
  projects: string[];
}) {
  const workerLabel = opts.workerOnline
    ? opts.hostname
      ? `${opts.hostname}${opts.version ? ` (v${opts.version})` : ""}`
      : "online"
    : "offline";
  const projects =
    opts.projects.length > 0 ? opts.projects.join(", ") : "(none)";

  return {
    type: "AdaptiveCard",
    $schema: "http://adaptivecards.io/schemas/adaptive-card.json",
    version: "1.4",
    body: [
      {
        type: "TextBlock",
        text: "AgentR status",
        weight: "Bolder",
        size: "Medium",
      },
      {
        type: "FactSet",
        facts: [
          { title: "Paired", value: opts.paired ? "yes" : "no" },
          { title: "Worker", value: workerLabel },
          { title: "Projects", value: projects },
        ],
      },
    ],
  };
}

export function buildApprovalCard(opts: {
  taskId: string;
  approvalId: string;
  command: string;
  reason: string;
}) {
  return {
    type: "AdaptiveCard",
    $schema: "http://adaptivecards.io/schemas/adaptive-card.json",
    version: "1.4",
    body: [
      {
        type: "TextBlock",
        text: "⚠️ Approval required",
        weight: "Bolder",
        size: "Medium",
        color: "Warning",
      },
      {
        type: "TextBlock",
        text: opts.reason,
        wrap: true,
      },
      {
        type: "TextBlock",
        text: `\`${opts.command}\``,
        wrap: true,
        fontType: "Monospace",
      },
    ],
    actions: [
      {
        type: "Action.Submit",
        title: "Approve",
        style: "positive",
        data: {
          action: "approval",
          decision: "approve",
          taskId: opts.taskId,
          approvalId: opts.approvalId,
        },
      },
      {
        type: "Action.Submit",
        title: "Reject",
        style: "destructive",
        data: {
          action: "approval",
          decision: "reject",
          taskId: opts.taskId,
          approvalId: opts.approvalId,
        },
      },
    ],
  };
}
