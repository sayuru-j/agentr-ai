import type { TaskStatus } from "@agentr/shared";

/** Adaptive Cards in Teams only support a Markdown subset — soften full .md. */
function toTeamsMarkdown(raw: string): string {
  let text = raw.replace(/\r\n/g, "\n").trimEnd();
  if (!text.trim()) return "_Waiting for worker output…_";

  // Headers → bold lines (Teams AC doesn't render # headings)
  text = text.replace(/^#{1,6}\s+(.+)$/gm, "**$1**");

  // Keep length bounded for Adaptive Card updates (long output goes to thread)
  if (text.length > 1800) {
    text = "…\n" + text.slice(-1800);
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
  queuePosition?: number;
  exitCode?: number;
}) {
  const logText =
    opts.logs.length === 0
      ? opts.status === "queued"
        ? `_Queued${opts.queuePosition ? ` (#${opts.queuePosition})` : ""} — waiting for the current task…_`
        : "_Waiting for worker output…_"
      : toTeamsMarkdown(opts.logs.join(""));

  const statusEmoji: Record<TaskStatus, string> = {
    queued: "…",
    running: "⏳",
    succeeded: "✅",
    failed: "❌",
    cancelled: "🛑",
  };

  const facts: Array<{ title: string; value: string }> = [
    { title: "Status", value: opts.status },
    { title: "Task", value: opts.taskId.slice(0, 8) },
  ];
  if (opts.projectAlias) facts.push({ title: "Project", value: opts.projectAlias });
  if (opts.hostname) facts.push({ title: "Worker", value: opts.hostname });
  if (typeof opts.exitCode === "number") {
    facts.push({ title: "Exit", value: String(opts.exitCode) });
  }
  if (opts.queuePosition && opts.status === "queued") {
    facts.push({ title: "Queue", value: `#${opts.queuePosition}` });
  }

  const body: Record<string, unknown>[] = [
    {
      type: "TextBlock",
      text: `${statusEmoji[opts.status]} AgentR Task`,
      weight: "Bolder",
      size: "Medium",
    },
    { type: "FactSet", facts },
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
    {
      type: "TextBlock",
      text: "_Longer logs appear as replies under this card._",
      wrap: true,
      size: "Small",
      isSubtle: true,
      spacing: "Small",
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
          { title: "/projects", value: "List project aliases (`!alias`)" },
          { title: "/status", value: "Worker connection status" },
          { title: "/last", value: "Last task prompt / exit / short log" },
          { title: "/model", value: "`/model` or `/model <name>` (e.g. `auto`)" },
          { title: "/ss", value: "Preview screenshots (all monitors)" },
          { title: "/sshq", value: "High-quality screenshots (all monitors)" },
          {
            title: "/get",
            value: "`!alias /get path` — fetch a project file (≤1.5 MB)",
          },
          { title: "/cancel", value: "Cancel the running or queued agent task" },
          { title: "/help", value: "This help card" },
          {
            title: "Task",
            value: "`!alias your prompt` — attach files to drop into the project",
          },
        ],
      },
    ],
  };
}

export function buildFileGetCard(opts: {
  alias: string;
  relativePath: string;
  sizeLabel: string;
  url: string;
  mimeType: string;
}) {
  return {
    type: "AdaptiveCard",
    $schema: "http://adaptivecards.io/schemas/adaptive-card.json",
    version: "1.4",
    body: [
      {
        type: "TextBlock",
        text: "Project file",
        weight: "Bolder",
        size: "Medium",
      },
      {
        type: "FactSet",
        facts: [
          { title: "Project", value: `!${opts.alias}` },
          { title: "Path", value: opts.relativePath },
          { title: "Size", value: opts.sizeLabel },
          { title: "Type", value: opts.mimeType },
        ],
      },
    ],
    actions: [
      {
        type: "Action.OpenUrl",
        title: "Download",
        url: opts.url,
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
  agentModel?: string;
  latencyMs?: number | null;
  lastTask?: {
    status: string;
    prompt: string;
    projectAlias?: string;
    exitCode?: number;
    createdAt: number;
  } | null;
  disks?: Array<{
    alias: string;
    freeLabel: string;
    totalLabel?: string;
    error?: string;
  }>;
}) {
  const workerLabel = opts.workerOnline
    ? opts.hostname
      ? `${opts.hostname}${opts.version ? ` (v${opts.version})` : ""}`
      : "online"
    : "offline";
  const projects =
    opts.projects.length > 0 ? opts.projects.join(", ") : "(none)";

  const facts: Array<{ title: string; value: string }> = [
    { title: "Paired", value: opts.paired ? "yes" : "no" },
    { title: "Worker", value: workerLabel },
    { title: "Projects", value: projects },
  ];
  if (opts.agentModel) {
    facts.push({ title: "Model", value: opts.agentModel });
  }
  if (typeof opts.latencyMs === "number") {
    facts.push({ title: "Latency", value: `${opts.latencyMs} ms` });
  } else if (opts.workerOnline && opts.latencyMs === null) {
    facts.push({ title: "Latency", value: "timeout" });
  }

  if (opts.lastTask) {
    const when = new Date(opts.lastTask.createdAt)
      .toISOString()
      .replace("T", " ")
      .slice(0, 16);
    const exit =
      typeof opts.lastTask.exitCode === "number"
        ? ` · exit ${opts.lastTask.exitCode}`
        : "";
    const alias = opts.lastTask.projectAlias
      ? `!${opts.lastTask.projectAlias} `
      : "";
    const prompt =
      opts.lastTask.prompt.length > 80
        ? `${opts.lastTask.prompt.slice(0, 80)}…`
        : opts.lastTask.prompt;
    facts.push({
      title: "Last task",
      value: `${opts.lastTask.status}${exit} · ${when} UTC`,
    });
    facts.push({
      title: "Last prompt",
      value: `${alias}${prompt}`,
    });
  }

  const body: Record<string, unknown>[] = [
    {
      type: "TextBlock",
      text: "AgentR status",
      weight: "Bolder",
      size: "Medium",
    },
    { type: "FactSet", facts },
  ];

  if (opts.disks && opts.disks.length > 0) {
    body.push({
      type: "TextBlock",
      text: "Project disk",
      weight: "Bolder",
      spacing: "Medium",
    });
    body.push({
      type: "FactSet",
      facts: opts.disks.map((d) => ({
        title: `!${d.alias}`,
        value: d.error
          ? d.error
          : d.totalLabel
            ? `${d.freeLabel} free / ${d.totalLabel}`
            : `${d.freeLabel} free`,
      })),
    });
  }

  return {
    type: "AdaptiveCard",
    $schema: "http://adaptivecards.io/schemas/adaptive-card.json",
    version: "1.4",
    body,
  };
}

export function buildProjectsCard(opts: {
  projects: string[];
  hostname?: string;
}) {
  const list =
    opts.projects.length === 0
      ? "_No projects — add aliases in the AgentR tray._"
      : opts.projects.map((a) => `• \`!${a}\``).join("\n");

  return {
    type: "AdaptiveCard",
    $schema: "http://adaptivecards.io/schemas/adaptive-card.json",
    version: "1.4",
    body: [
      {
        type: "TextBlock",
        text: "Projects",
        weight: "Bolder",
        size: "Medium",
      },
      {
        type: "TextBlock",
        text: opts.hostname
          ? `Aliases on **${opts.hostname}**. Use \`!alias your prompt\`.`
          : "Use `!alias your prompt`.",
        wrap: true,
        isSubtle: true,
      },
      {
        type: "TextBlock",
        text: list,
        wrap: true,
      },
    ],
  };
}

export function buildLastTaskCard(opts: {
  taskId: string;
  prompt: string;
  status: TaskStatus;
  projectAlias?: string;
  exitCode?: number;
  logs: string[];
  createdAt: number;
}) {
  const snippet = toTeamsMarkdown(opts.logs.join("").slice(-1200));
  const when = new Date(opts.createdAt).toISOString().replace("T", " ").slice(0, 19);

  return {
    type: "AdaptiveCard",
    $schema: "http://adaptivecards.io/schemas/adaptive-card.json",
    version: "1.4",
    body: [
      {
        type: "TextBlock",
        text: "Last task",
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
          ...(typeof opts.exitCode === "number"
            ? [{ title: "Exit", value: String(opts.exitCode) }]
            : []),
          { title: "When", value: `${when} UTC` },
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
        text: snippet,
        wrap: true,
        size: "Small",
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
