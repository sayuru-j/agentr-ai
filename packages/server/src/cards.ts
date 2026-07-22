import type { TaskStatus } from "@agentr/shared";

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
      : "```\n" + opts.logs.slice(-40).join("").slice(-3500) + "\n```";

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
        fontType: "Monospace",
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
