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

  // Adaptive Cards treat single \n weakly; keep paragraphs readable
  return text;
}

export function buildTaskCard(opts: {
  taskId: string;
  prompt: string;
  status: TaskStatus;
  projectAlias?: string;
  logs: string[];
  hostname?: string;
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

  return {
    type: "AdaptiveCard",
    $schema: "http://adaptivecards.io/schemas/adaptive-card.json",
    version: "1.4",
    body: [
      {
        type: "TextBlock",
        text: `${statusEmoji[opts.status]} AgentRelay Task`,
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
