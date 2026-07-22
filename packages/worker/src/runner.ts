import { matchRiskCommand } from "@agentr/shared";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";

export interface RunTaskOptions {
  taskId: string;
  prompt: string;
  cwd: string;
  agentCommand: string;
  /** Cursor CLI model id; default `auto`. */
  agentModel?: string;
  dryRun?: boolean;
  requestApproval: (command: string, reason: string) => Promise<boolean>;
  onLog: (stream: "stdout" | "stderr", chunk: string) => void;
}

export interface TaskRunnerEvents {
  exit: [code: number | null];
}

/**
 * On Windows, `spawn(..., { shell: true })` joins args with spaces and does
 * not escape them — paths like `C:\Users\Sayuru at Fleximal\...` get truncated.
 * Quote for cmd.exe when needed.
 */
function quoteWinCmdArg(arg: string): string {
  if (arg.length >= 2 && arg.startsWith('"') && arg.endsWith('"')) return arg;
  if (!/[ \t"&<>|^%!]/.test(arg)) return arg;
  return `"${arg.replace(/"/g, '""')}"`;
}

/** Extract human-readable text from Cursor CLI `--output-format stream-json` lines. */
class StreamJsonDecoder {
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
      return formatStreamEvent(ev, this);
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

function formatStreamEvent(
  ev: Record<string, unknown>,
  decoder: StreamJsonDecoder,
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
    // With --stream-partial-output: only use deltas (timestamp_ms, no model_call_id).
    if (ev.model_call_id) return null;
    if (ev.timestamp_ms != null) {
      decoder.markPartial();
      return text;
    }
    // Full segment (no partial mode) — keep. Final duplicate flush after partials — skip.
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

/**
 * Spawns headless `agent` against a project folder and streams output.
 * Uses stream-json + partial deltas so Teams/console update live.
 * `windowsHide: false` so Electron does not swallow the console on Windows.
 */
export class TaskRunner extends EventEmitter {
  private child: ChildProcessWithoutNullStreams | null = null;
  private killed = false;

  async run(opts: RunTaskOptions): Promise<number> {
    if (opts.dryRun) {
      return this.runDry(opts);
    }

    const model = (opts.agentModel || "auto").trim() || "auto";
    // Prefer Markdown answers so Teams Adaptive Cards can render formatting.
    const prompt = `${opts.prompt.trim()}\n\nReply in Markdown.`;
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
      prompt,
    ];

    const useShell = process.platform === "win32";
    this.child = spawn(opts.agentCommand, useShell ? args.map(quoteWinCmdArg) : args, {
      cwd: opts.cwd,
      env: process.env,
      shell: useShell,
      // Electron defaults to hiding consoles; keep agent visible on the PC.
      windowsHide: false,
    });

    const decoder = new StreamJsonDecoder();

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

    // Simulate token streaming
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
