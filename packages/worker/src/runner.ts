import {
  matchRiskWithGuardrails,
  type ProjectGuardrails,
  type ResumeContext,
  type ResumeMode,
} from "@agentr/shared";
import { spawn, type ChildProcessWithoutNullStreams, execFileSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import {
  type AgentBackend,
  defaultModelForBackend,
  parseAgentBackend,
} from "./config.js";
import { buildCodexExecArgs, detectCodexCliProfile } from "./codex-cli.js";
import { detectResumeSupport } from "./agent-diagnose.js";
import { buildResumePrompt } from "./task-context.js";
import { stripConfiguredCommand } from "./resolve-agent.js";

export interface RunTaskOptions {
  taskId: string;
  prompt: string;
  cwd: string;
  agentCommand: string;
  agentBackend?: AgentBackend | string;
  agentModel?: string;
  dryRun?: boolean;
  guardrails?: ProjectGuardrails;
  maxRuntimeMinutes?: number;
  resumeMode?: ResumeMode;
  resumeContext?: ResumeContext;
  requestApproval: (
    command: string,
    reason: string,
    tier: "block" | "approve",
  ) => Promise<boolean>;
  onLog: (stream: "stdout" | "stderr", chunk: string) => void;
  onAgentThreadId?: (threadId: string) => void;
}

export interface TaskRunnerEvents {
  exit: [code: number | null];
}

export interface TaskRunResult {
  exitCode: number;
  agentThreadId?: string;
  logText: string;
}

function quoteWinCmdArg(arg: string): string {
  const trimmed = arg.trim();
  if (trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')) {
    return trimmed;
  }
  if (!/[ \t"&<>|^%!]/.test(trimmed)) return trimmed;
  return `"${trimmed.replace(/"/g, '""')}"`;
}

function spawnAgentProcess(
  agentCommand: string,
  args: string[],
  opts: { cwd: string; env: NodeJS.ProcessEnv },
): ChildProcessWithoutNullStreams {
  const command = stripConfiguredCommand(agentCommand);

  if (process.platform === "win32") {
    return spawn(quoteWinCmdArg(command), args.map(quoteWinCmdArg), {
      cwd: opts.cwd,
      env: opts.env,
      shell: true,
      windowsHide: false,
    });
  }

  return spawn(command, args, {
    cwd: opts.cwd,
    env: opts.env,
    shell: false,
    windowsHide: false,
  });
}

type LineDecoder = {
  push(chunk: string): string[];
  flush(): string[];
};

function readAgentHelp(agentCommand: string, backend: AgentBackend): string {
  const cmd = stripConfiguredCommand(agentCommand);
  const isAbsolute = /[\\/]/.test(cmd) || /^[a-zA-Z]:/.test(cmd);
  const args = backend === "codex" ? ["exec", "--help"] : ["--help"];
  try {
    return execFileSync(cmd, args, {
      encoding: "utf8",
      timeout: 8000,
      windowsHide: true,
      shell: process.platform === "win32" && !isAbsolute,
    });
  } catch {
    return "";
  }
}

class CursorStreamJsonDecoder implements LineDecoder {
  private buffer = "";
  private seenPartial = false;
  private sessionId: string | undefined;

  constructor(private onSessionId?: (id: string) => void) {}

  push(chunk: string): string[] {
    this.buffer += chunk;
    const lines = this.buffer.split(/\r?\n/);
    this.buffer = lines.pop() ?? "";
    const out: string[] = [];
    for (const line of lines) {
      const text = this.decodeLine(line);
      if (text) out.push(text);
    }
    return out;
  }

  flush(): string[] {
    if (!this.buffer.trim()) return [];
    const text = this.decodeLine(this.buffer);
    this.buffer = "";
    return text ? [text] : [];
  }

  getSessionId(): string | undefined {
    return this.sessionId;
  }

  private decodeLine(line: string): string | null {
    const trimmed = line.trim();
    if (!trimmed) return null;
    if (trimmed[0] !== "{") {
      return line.endsWith("\n") ? line : `${line}\n`;
    }
    try {
      const ev = JSON.parse(trimmed) as Record<string, unknown>;
      return formatCursorStreamEvent(ev, this);
    } catch {
      return `${line}\n`;
    }
  }

  markPartial(): void {
    this.seenPartial = true;
  }

  get hasSeenPartial(): boolean {
    return this.seenPartial;
  }

  captureSessionId(id: string): void {
    if (!this.sessionId) {
      this.sessionId = id;
      this.onSessionId?.(id);
    }
  }
}

function formatCursorStreamEvent(
  ev: Record<string, unknown>,
  decoder: CursorStreamJsonDecoder,
): string | null {
  const type = ev.type;
  if (type === "system" && ev.subtype === "init") {
    const model = String(ev.model ?? "?");
    const sid = ev.session_id ?? ev.conversation_id ?? ev.thread_id;
    if (typeof sid === "string") decoder.captureSessionId(sid);
    return `[agent] ${model}\n`;
  }
  if (type === "assistant") {
    const message = ev.message as
      | { content?: Array<{ type?: string; text?: string }> }
      | undefined;
    const text = (message?.content ?? [])
      .filter((c) => c.type === "text" && c.text)
      .map((c) => c.text!)
      .join("");
    if (!text) return null;
    if (ev.model_call_id) return null;
    if (ev.timestamp_ms != null) {
      decoder.markPartial();
      return text;
    }
    if (decoder.hasSeenPartial) return null;
    return text;
  }
  if (type === "tool_call" && ev.subtype === "started") {
    const toolCall = (ev.tool_call ?? {}) as Record<string, unknown>;
    const name = Object.keys(toolCall)[0]?.replace(/ToolCall$/, "") ?? "tool";
    return `\n⚙ ${name}…\n`;
  }
  if (type === "result" && ev.is_error) {
    return `\n[error] ${String(ev.result ?? "failed")}\n`;
  }
  return null;
}

class CodexJsonlDecoder implements LineDecoder {
  private buffer = "";
  private threadId: string | undefined;

  constructor(private onThreadId?: (id: string) => void) {}

  push(chunk: string): string[] {
    this.buffer += chunk;
    const lines = this.buffer.split(/\r?\n/);
    this.buffer = lines.pop() ?? "";
    const out: string[] = [];
    for (const line of lines) {
      const text = this.decodeLine(line);
      if (text) out.push(text);
    }
    return out;
  }

  flush(): string[] {
    if (!this.buffer.trim()) return [];
    const text = this.decodeLine(this.buffer);
    this.buffer = "";
    return text ? [text] : [];
  }

  getThreadId(): string | undefined {
    return this.threadId;
  }

  private decodeLine(line: string): string | null {
    const trimmed = line.trim();
    if (!trimmed) return null;
    if (trimmed[0] !== "{") {
      return line.endsWith("\n") ? line : `${line}\n`;
    }
    try {
      const ev = JSON.parse(trimmed) as Record<string, unknown>;
      return formatCodexEvent(ev, this);
    } catch {
      return `${line}\n`;
    }
  }

  captureThreadId(id: string): void {
    if (!this.threadId) {
      this.threadId = id;
      this.onThreadId?.(id);
    }
  }
}

function pickText(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value;
  }
  return null;
}

function formatCodexEvent(
  ev: Record<string, unknown>,
  decoder: CodexJsonlDecoder,
): string | null {
  const type = String(ev.type ?? "");

  if (type === "thread.started") {
    const id = pickText(ev.thread_id, ev.id);
    if (id) decoder.captureThreadId(id);
    return id ? `[codex] thread ${id}\n` : `[codex] started\n`;
  }
  if (type === "turn.started") return `[codex] turn…\n`;
  if (type === "turn.failed" || type === "error") {
    const msg =
      pickText(ev.error, ev.message, (ev.error as { message?: string } | undefined)?.message) ??
      "failed";
    return `\n[error] ${msg}\n`;
  }
  if (type === "turn.completed") return null;

  if (type.startsWith("item.")) {
    const item = (ev.item ?? ev) as Record<string, unknown>;
    const itemType = String(item.type ?? item.item_type ?? "");
    const text = pickText(
      item.text,
      item.message,
      item.content,
      (item as { output?: string }).output,
    );

    if (
      itemType.includes("agent_message") ||
      itemType.includes("message") ||
      itemType === "assistant"
    ) {
      if (type.endsWith(".delta") && text) return text;
      if ((type.endsWith(".completed") || type === "item.completed") && text) {
        return text.endsWith("\n") ? text : `${text}\n`;
      }
      if (text && type.endsWith(".started") === false) {
        return text.endsWith("\n") ? text : `${text}\n`;
      }
    }

    if (
      itemType.includes("command") ||
      itemType.includes("tool") ||
      itemType.includes("execution")
    ) {
      if (type.endsWith(".started")) {
        const cmd =
          pickText(item.command, item.name, item.tool, item.title) ?? "command";
        return `\n⚙ ${cmd}…\n`;
      }
      if (type.endsWith(".completed") && text) {
        return text.endsWith("\n") ? text : `${text}\n`;
      }
    }

    if (type.endsWith(".started") && itemType) {
      return `\n⚙ ${itemType}…\n`;
    }
  }

  if (ev.data && typeof ev.data === "object") {
    return formatCodexEvent(
      {
        ...(ev.data as Record<string, unknown>),
        type: (ev.data as { type?: unknown }).type ?? type,
      },
      decoder,
    );
  }

  return null;
}

function buildCursorArgs(
  opts: RunTaskOptions,
  model: string,
  prompt: string,
  help: string,
): string[] {
  const args = [
    "--print",
    "--output-format",
    "stream-json",
    "--stream-partial-output",
    "--trust",
    "--force",
    "--model",
    model,
    `--workspace=${opts.cwd}`,
  ];

  const resume = detectResumeSupport(help, "cursor");
  const threadId = opts.resumeContext?.agentThreadId;
  if (opts.resumeMode === "continue" && threadId && resume.resumeFlag) {
    args.push(resume.resumeFlag, threadId);
  }

  args.push(prompt);
  return args;
}

function buildCodexArgs(
  opts: RunTaskOptions,
  model: string,
  prompt: string,
): string[] {
  const profile = detectCodexCliProfile(opts.agentCommand);
  const threadId =
    opts.resumeMode === "continue" ? opts.resumeContext?.agentThreadId : undefined;
  const nativeResume =
    Boolean(threadId) && Boolean(profile.resumeFlag || profile.threadFlag);

  return buildCodexExecArgs(
    { cwd: opts.cwd, agentThreadId: nativeResume ? threadId : undefined },
    model,
    prompt,
    opts.agentCommand,
  );
}

function resolvePrompt(opts: RunTaskOptions): string {
  let body = opts.prompt.trim();

  if (opts.resumeMode === "continue" && opts.resumeContext) {
    const backend = parseAgentBackend(opts.agentBackend);
    const profile = backend === "codex" ? detectCodexCliProfile(opts.agentCommand) : null;
    const help = readAgentHelp(opts.agentCommand, backend);
    const cursorResume = detectResumeSupport(help, "cursor");
    const hasNative =
      backend === "codex"
        ? Boolean(
            opts.resumeContext.agentThreadId &&
              (profile?.resumeFlag || profile?.threadFlag),
          )
        : Boolean(opts.resumeContext.agentThreadId && cursorResume.resumeFlag);

    if (!hasNative) {
      body = buildResumePrompt(
        {
          priorPrompt: opts.resumeContext.priorPrompt,
          logSummary: opts.resumeContext.logSummary,
        },
        body,
      );
    }
  }

  return `${body}\n\nReply in Markdown.`;
}

export class TaskRunner extends EventEmitter {
  private child: ChildProcessWithoutNullStreams | null = null;
  private killed = false;
  private runtimeTimer: ReturnType<typeof setTimeout> | null = null;

  async run(opts: RunTaskOptions): Promise<TaskRunResult> {
    const logParts: string[] = [];
    const onLog: RunTaskOptions["onLog"] = (stream, chunk) => {
      logParts.push(chunk);
      opts.onLog(stream, chunk);
    };

    if (opts.guardrails?.readOnly || opts.dryRun) {
      const code = await this.runDry({ ...opts, onLog });
      return { exitCode: code, logText: logParts.join("") };
    }

    const backend = parseAgentBackend(opts.agentBackend);
    const model =
      (opts.agentModel || defaultModelForBackend(backend)).trim() ||
      defaultModelForBackend(backend);
    const prompt = resolvePrompt(opts);
    const help = readAgentHelp(opts.agentCommand, backend);
    const args =
      backend === "codex"
        ? buildCodexArgs(opts, model, prompt)
        : buildCursorArgs(opts, model, prompt, help);

    let agentThreadId: string | undefined;
    const onThread = (id: string) => {
      agentThreadId = id;
      opts.onAgentThreadId?.(id);
    };

    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawnAgentProcess(opts.agentCommand, args, {
        cwd: opts.cwd,
        env: process.env,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      onLog("stderr", `\n[agent-relay] Failed to spawn: ${msg}\n`);
      return { exitCode: 1, logText: logParts.join("") };
    }
    this.child = child;

    const decoder: LineDecoder =
      backend === "codex"
        ? new CodexJsonlDecoder(onThread)
        : new CursorStreamJsonDecoder(onThread);

    if (opts.maxRuntimeMinutes && opts.maxRuntimeMinutes > 0) {
      this.runtimeTimer = setTimeout(
        () => {
          onLog(
            "stderr",
            `\n[agent-relay] Max runtime (${opts.maxRuntimeMinutes} min) exceeded — cancelling\n`,
          );
          this.cancel();
        },
        opts.maxRuntimeMinutes * 60_000,
      );
    }

    const handleChunk = async (stream: "stdout" | "stderr", chunk: string) => {
      const pieces =
        stream === "stdout" ? decoder.push(chunk) : chunk ? [chunk] : [];
      for (const piece of pieces) {
        onLog(stream, piece);
        const lines = piece.split(/\r?\n/);
        for (const line of lines) {
          const risk = matchRiskWithGuardrails(line, opts.guardrails);
          if (!risk) continue;
          if (risk.tier === "block") {
            onLog("stderr", `\n[agent-relay] Blocked: ${risk.command}\n`);
            this.cancel();
            return;
          }
          const approved = await opts.requestApproval(
            risk.command,
            risk.reason,
            "approve",
          );
          if (!approved) {
            onLog("stderr", `\n[agent-relay] Rejected: ${risk.command}\n`);
            this.cancel();
            return;
          }
          onLog("stdout", `\n[agent-relay] Approved: ${risk.command}\n`);
        }
      }
    };

    this.child.stdout.on("data", (buf: Buffer) => {
      void handleChunk("stdout", buf.toString("utf8"));
    });
    this.child.stderr.on("data", (buf: Buffer) => {
      void handleChunk("stderr", buf.toString("utf8"));
    });

    const exitCode = await new Promise<number>((resolve) => {
      this.child!.on("close", (code) => {
        if (this.runtimeTimer) clearTimeout(this.runtimeTimer);
        for (const piece of decoder.flush()) {
          onLog("stdout", piece);
        }
        if (!agentThreadId) {
          if (decoder instanceof CodexJsonlDecoder) {
            agentThreadId = decoder.getThreadId();
          } else if (decoder instanceof CursorStreamJsonDecoder) {
            agentThreadId = decoder.getSessionId();
          }
        }
        this.child = null;
        resolve(this.killed ? 130 : (code ?? 1));
      });
      this.child!.on("error", (err) => {
        if (this.runtimeTimer) clearTimeout(this.runtimeTimer);
        onLog("stderr", `\n[agent-relay] Failed to spawn: ${err.message}\n`);
        this.child = null;
        resolve(1);
      });
    });

    return {
      exitCode,
      agentThreadId,
      logText: logParts.join(""),
    };
  }

  private async runDry(opts: RunTaskOptions): Promise<number> {
    const backend = parseAgentBackend(opts.agentBackend);
    opts.onLog("stdout", `[dry-run] Backend: ${backend}\n`);
    opts.onLog("stdout", `[dry-run] Starting task in ${opts.cwd}\n`);
    opts.onLog("stdout", `[dry-run] Prompt: ${opts.prompt}\n`);

    if (/\bnpm install\b/i.test(opts.prompt) || opts.prompt.includes("--approve-test")) {
      const approved = await opts.requestApproval(
        "npm install",
        "Package install/uninstall modifies node_modules",
        "approve",
      );
      if (!approved) {
        opts.onLog("stderr", "[dry-run] Approval rejected — aborting\n");
        return 1;
      }
      opts.onLog("stdout", "[dry-run] Approval granted — continuing\n");
    }

    const words = "[dry-run] Streaming sample output from AgentR…\n".split(" ");
    for (const w of words) {
      opts.onLog("stdout", w.endsWith("\n") ? w : `${w} `);
      await delay(40);
    }
    opts.onLog("stdout", "[dry-run] Done.\n");
    return 0;
  }

  cancel(): void {
    this.killed = true;
    if (this.runtimeTimer) clearTimeout(this.runtimeTimer);
    if (this.child && !this.child.killed) {
      this.child.kill("SIGTERM");
      setTimeout(() => {
        if (this.child && !this.child.killed) {
          this.child.kill("SIGKILL");
        }
      }, 3000);
    }
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export function newApprovalId(): string {
  return randomUUID();
}

export function buildTaskSummary(logText: string, exitCode: number): string {
  const lines = logText
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .filter((l) => !l.startsWith("[agent") && !l.startsWith("[codex]"))
    .slice(-3);
  const tail = lines.join(" · ").slice(0, 200);
  if (exitCode === 0) return tail || "Completed successfully";
  if (exitCode === 130) return "Cancelled";
  return tail || `Failed with exit code ${exitCode}`;
}
