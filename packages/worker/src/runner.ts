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

/**
 * Spawns headless `agent` against a project folder and streams output.
 * Defaults to Cursor Auto (`--model auto`). Passes `--trust` because projects
 * are already chosen by the user in the tray (no interactive trust prompt).
 * Uses `--print` + `--force` so the CLI does not hang waiting for a TTY.
 *
 * Scans lines for risk patterns; when matched, requests Teams approval
 * (MVP: kill/continue based on decision). Cursor CLI may not expose a true
 * "pause before shell" hook — risk scanning is best-effort on streamed output.
 */
export class TaskRunner extends EventEmitter {
  private child: ChildProcessWithoutNullStreams | null = null;
  private killed = false;

  async run(opts: RunTaskOptions): Promise<number> {
    if (opts.dryRun) {
      return this.runDry(opts);
    }

    const model = (opts.agentModel || "auto").trim() || "auto";
    // Prefer `--workspace=<path>` as one argv so spaced paths stay intact.
    const args = [
      "--print",
      "--trust",
      "--force",
      "--model",
      model,
      `--workspace=${opts.cwd}`,
      "chat",
      opts.prompt,
    ];

    const useShell = process.platform === "win32";
    this.child = spawn(opts.agentCommand, useShell ? args.map(quoteWinCmdArg) : args, {
      cwd: opts.cwd,
      env: process.env,
      shell: useShell,
    });

    const scan = async (stream: "stdout" | "stderr", chunk: string) => {
      opts.onLog(stream, chunk);
      const lines = chunk.split(/\r?\n/);
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
    };

    this.child.stdout.on("data", (buf: Buffer) => {
      void scan("stdout", buf.toString("utf8"));
    });
    this.child.stderr.on("data", (buf: Buffer) => {
      void scan("stderr", buf.toString("utf8"));
    });

    return new Promise((resolve) => {
      this.child!.on("close", (code) => {
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

    // Simulate a risky command in the stream for approval testing
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

    await delay(300);
    const model = (opts.agentModel || "auto").trim() || "auto";
    opts.onLog(
      "stdout",
      `[dry-run] Would run: agent --print --trust --force --model ${model} --workspace=… chat …\n`,
    );
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
