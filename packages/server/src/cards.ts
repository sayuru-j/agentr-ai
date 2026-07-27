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
            value: "`!alias /get path` — fetch a file (basename OK; ≤1.5 MB)",
          },
          { title: "/cancel", value: "Cancel the running or queued agent task" },
          { title: "/continue", value: "Resume the last task (`/continue prompt`)" },
          { title: "/queue", value: "Show running and queued tasks" },
          { title: "/history", value: "`/history [n]` — recent tasks (default 10)" },
          { title: "/prompts", value: "List prompt shortcuts for `!alias /run name`" },
          { title: "/help", value: "This help card" },
          {
            title: "Task",
            value: "`!alias your prompt` — `/continue`, `/run`, `/get`; attach files → `.agentr-inbox/`",
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
  /** Optional short preview — keep tiny; large previews break Teams. */
  preview?: string;
  truncated?: boolean;
}) {
  const body: Record<string, unknown>[] = [
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
  ];

  if (opts.preview != null && opts.preview.length > 0) {
    const clipped =
      opts.preview.length > 500 ? `${opts.preview.slice(0, 500)}…` : opts.preview;
    body.push({
      type: "TextBlock",
      text: opts.truncated ? `${clipped}\n(truncated)` : clipped,
      wrap: true,
      size: "Small",
      spacing: "Medium",
    });
  }

  return {
    type: "AdaptiveCard",
    $schema: "http://adaptivecards.io/schemas/adaptive-card.json",
    version: "1.4",
    body,
    actions: [
      {
        type: "Action.OpenUrl",
        title: "Download file",
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
  agentBackend?: string;
  sessionLocked?: boolean;
  queueDepth?: number;
  workerOfflineSince?: string;
  cliDiagnosis?: { ok: boolean; version?: string; errors?: string[] };
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
  if (opts.agentBackend) {
    facts.push({ title: "Backend", value: opts.agentBackend });
  }
  if (opts.sessionLocked) {
    facts.push({ title: "Session", value: "locked" });
  }
  if (typeof opts.queueDepth === "number" && opts.queueDepth > 0) {
    facts.push({ title: "Queue", value: String(opts.queueDepth) });
  }
  if (!opts.workerOnline && opts.workerOfflineSince) {
    facts.push({ title: "Offline since", value: opts.workerOfflineSince });
  }
  if (opts.cliDiagnosis) {
    const cliLabel = opts.cliDiagnosis.ok
      ? `OK${opts.cliDiagnosis.version ? ` (${opts.cliDiagnosis.version})` : ""}`
      : opts.cliDiagnosis.errors?.[0] ?? "check failed";
    facts.push({ title: "Agent CLI", value: cliLabel });
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
  projectAlias?: string;
  cwd?: string;
  gitBranch?: string;
  gitDirty?: boolean;
  screenshotUrl?: string;
}) {
  const facts: Array<{ title: string; value: string }> = [];
  if (opts.projectAlias) facts.push({ title: "Project", value: opts.projectAlias });
  if (opts.cwd) facts.push({ title: "Folder", value: opts.cwd });
  if (opts.gitBranch) {
    facts.push({
      title: "Git",
      value: `${opts.gitBranch}${opts.gitDirty ? " (dirty)" : " (clean)"}`,
    });
  }

  const body: Record<string, unknown>[] = [
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
  ];
  if (facts.length > 0) {
    body.splice(2, 0, { type: "FactSet", facts });
  }
  if (opts.screenshotUrl) {
    body.push({
      type: "Image",
      url: opts.screenshotUrl,
      altText: "Desktop at approval time",
      size: "Stretch",
    });
  }

  return {
    type: "AdaptiveCard",
    $schema: "http://adaptivecards.io/schemas/adaptive-card.json",
    version: "1.4",
    body,
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

export function buildQueueCard(opts: {
  runningTaskId?: string;
  queuedTaskIds: string[];
  hostname?: string;
}) {
  const facts: Array<{ title: string; value: string }> = [];
  if (opts.hostname) facts.push({ title: "Worker", value: opts.hostname });
  if (opts.runningTaskId) {
    facts.push({ title: "Running", value: opts.runningTaskId.slice(0, 8) });
  }
  opts.queuedTaskIds.forEach((id, i) => {
    facts.push({ title: `Queued #${i + 1}`, value: id.slice(0, 8) });
  });
  if (facts.length === 0) {
    facts.push({ title: "Queue", value: "empty" });
  }
  return {
    type: "AdaptiveCard",
    $schema: "http://adaptivecards.io/schemas/adaptive-card.json",
    version: "1.4",
    body: [
      {
        type: "TextBlock",
        text: "Task queue",
        weight: "Bolder",
        size: "Medium",
      },
      { type: "FactSet", facts },
    ],
  };
}

export function buildHistoryCard(opts: {
  entries: Array<{
    taskId: string;
    prompt: string;
    projectAlias?: string;
    status: string;
    exitCode?: number;
    summary?: string;
    createdAt: number;
  }>;
  limit: number;
}) {
  const lines =
    opts.entries.length === 0
      ? "_No task history in this chat yet._"
      : opts.entries
          .map((e) => {
            const when = new Date(e.createdAt)
              .toISOString()
              .replace("T", " ")
              .slice(0, 16);
            const alias = e.projectAlias ? `!${e.projectAlias} ` : "";
            const prompt =
              e.prompt.length > 60 ? `${e.prompt.slice(0, 60)}…` : e.prompt;
            const exit =
              typeof e.exitCode === "number" ? ` · exit ${e.exitCode}` : "";
            const sum = e.summary ? `\n  _${e.summary.slice(0, 80)}_` : "";
            return `**${e.status}**${exit} · ${when} UTC\n${alias}${prompt}${sum}`;
          })
          .join("\n\n");

  return {
    type: "AdaptiveCard",
    $schema: "http://adaptivecards.io/schemas/adaptive-card.json",
    version: "1.4",
    body: [
      {
        type: "TextBlock",
        text: `Task history (last ${opts.limit})`,
        weight: "Bolder",
        size: "Medium",
      },
      {
        type: "TextBlock",
        text: lines,
        wrap: true,
        size: "Small",
      },
    ],
  };
}

export function buildPromptsCard(opts: {
  templates: Array<{ alias?: string; name: string; text: string }>;
}) {
  const lines =
    opts.templates.length === 0
      ? "_No shortcuts configured. Add `prompts` in tray project settings._"
      : opts.templates
          .map((t) => {
            const use = t.alias ? `!${t.alias} /run ${t.name}` : `/run ${t.name}`;
            const preview =
              t.text.length > 80 ? `${t.text.slice(0, 80)}…` : t.text;
            return `**${use}**\n${preview}`;
          })
          .join("\n\n");

  return {
    type: "AdaptiveCard",
    $schema: "http://adaptivecards.io/schemas/adaptive-card.json",
    version: "1.4",
    body: [
      {
        type: "TextBlock",
        text: "Prompt shortcuts",
        weight: "Bolder",
        size: "Medium",
      },
      {
        type: "TextBlock",
        text: lines,
        wrap: true,
        size: "Small",
      },
    ],
  };
}
