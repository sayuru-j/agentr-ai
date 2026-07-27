import { matchRiskCommand } from "@agentr/shared";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import {
  type AgentBackend,
  defaultModelForBackend,
  parseAgentBackend,
} from "./config.js";
import { buildCodexExecArgs } from "./codex-cli.js";
import { stripConfiguredCommand } from "./resolve-agent.js";

export interface RunTaskOptions {
  taskId: string;
  prompt: string;
  cwd: string;
  agentCommand: string;
  /** `cursor` (default) or `codex`. */
  agentBackend?: AgentBackend | string;
  /** Model id for the selected backend. */
  agentModel?: string;
  dryRun?: boolean;
  requestApproval: (command: string, reason: string) => Promise<boolean>;
  onLog: (stream: "stdout" | "stderr", chunk: string) => void;
}

export interface TaskRunnerEvents {
  exit: [code: number | null];
}

/**
 * On Windows, `spawn(..., { shell: true })` builds a cmd.exe line and does not
 * escape spaces — paths like `C:\Users\Sayuru at Fleximal\...\agent.cmd` get
 * truncated unless double-quoted (portable + installed).
 */
function quoteWinCmdArg(arg: string): string {
  const trimmed = arg.trim();
  if (trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')) {
    return trimmed;
  }
  if (!/[ \t"&<>|^%!]/.test(trimmed)) return trimmed;
  return `"${trimmed.replace(/"/g, '""')}"`;
}

/** Spawn agent CLI. On Windows use `shell: true` + quoted args (not `cmd /c`). */
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

/** Extract human-readable text from Cursor CLI `--output-format stream-json` lines. */
class CursorStreamJsonDecoder implements LineDecoder {
  private buffer = "";
  private seenPartial = false;

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
}

function formatCursorStreamEvent(
  ev: Record<string, unknown>,
  decoder: CursorStreamJsonDecoder,
): string | null {
  const type = ev.type;
  if (type === "system" && ev.subtype === "init") {
    const model = String(ev.model ?? "?");
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

/** Extract readable text from Codex CLI `codex exec --json` JSONL events. */
class CodexJsonlDecoder implements LineDecoder {
  private buffer = "";

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

  private decodeLine(line: string): string | null {
    const trimmed = line.trim();
    if (!trimmed) return null;
    if (trimmed[0] !== "{") {
      return line.endsWith("\n") ? line : `${line}\n`;
    }
    try {
      const ev = JSON.parse(trimmed) as Record<string, unknown>;
      return formatCodexEvent(ev);
    } catch {
      return `${line}\n`;
    }
  }
}

function pickText(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value;
  }
  return null;
}

function formatCodexEvent(ev: Record<string, unknown>): string | null {
  const type = String(ev.type ?? "");

  if (type === "thread.started") {
    const id = pickText(ev.thread_id, ev.id);
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

  // Some builds nest the payload under `data`.
  if (ev.data && typeof ev.data === "object") {
    return formatCodexEvent({
      ...(ev.data as Record<string, unknown>),
      type: (ev.data as { type?: unknown }).type ?? type,
    });
  }

  return null;
}

function buildCursorArgs(opts: RunTaskOptions, model: string, prompt: string): string[] {
  return [
    "--print",
    "--output-format",
    "stream-json",
    "--stream-partial-output",
    "--trust",
    "--force",
    "--model",
    model,
    `--workspace=${opts.cwd}`,
    prompt,
  ];
}

function buildCodexArgs(
  opts: RunTaskOptions,
  model: string,
  prompt: string,
): string[] {
  return buildCodexExecArgs(opts, model, prompt, opts.agentCommand);
}

/**
 * Spawns headless Cursor `agent` or OpenAI `codex exec` against a project folder
 * and streams output. `windowsHide: false` so Electron does not swallow the console.
 */
export class TaskRunner extends EventEmitter {
  private child: ChildProcessWithoutNullStreams | null = null;
  private killed = false;

  async run(opts: RunTaskOptions): Promise<number> {
    if (opts.dryRun) {
      return this.runDry(opts);
    }

    const backend = parseAgentBackend(opts.agentBackend);
    const model =
      (opts.agentModel || defaultModelForBackend(backend)).trim() ||
      defaultModelForBackend(backend);
    const prompt = `${opts.prompt.trim()}\n\nReply in Markdown.`;
    const args =
      backend === "codex"
        ? buildCodexArgs(opts, model, prompt)
        : buildCursorArgs(opts, model, prompt);

    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawnAgentProcess(opts.agentCommand, args, {
        cwd: opts.cwd,
        env: process.env,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      opts.onLog("stderr", `\n[agent-relay] Failed to spawn: ${msg}\n`);
      return 1;
    }
    this.child = child;

    const decoder: LineDecoder =
      backend === "codex" ? new CodexJsonlDecoder() : new CursorStreamJsonDecoder();

    const handleChunk = async (stream: "stdout" | "stderr", chunk: string) => {
      const pieces =
        stream === "stdout" ? decoder.push(chunk) : chunk ? [chunk] : [];
      for (const piece of pieces) {
        opts.onLog(stream, piece);
        const lines = piece.split(/\r?\n/);
        for (const line of lines) {
          const risk = matchRiskCommand(line);
          if (!risk) continue;
          const approved = await opts.requestApproval(risk.command, risk.reason);
          if (!approved) {
            opts.onLog("stderr", `\n[agent-relay] Rejected: ${risk.command}\n`);
            this.cancel();
            return;
          }
          opts.onLog("stdout", `\n[agent-relay] Approved: ${risk.command}\n`);
        }
      }
    };

    this.child.stdout.on("data", (buf: Buffer) => {
      void handleChunk("stdout", buf.toString("utf8"));
    });
    this.child.stderr.on("data", (buf: Buffer) => {
      void handleChunk("stderr", buf.toString("utf8"));
    });

    return new Promise((resolve) => {
      this.child!.on("close", (code) => {
        for (const piece of decoder.flush()) {
          opts.onLog("stdout", piece);
        }
        this.child = null;
        resolve(this.killed ? 130 : (code ?? 1));
      });
      this.child!.on("error", (err) => {
        opts.onLog("stderr", `\n[agent-relay] Failed to spawn: ${err.message}\n`);
        this.child = null;
        resolve(1);
      });
    });
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
