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
 * Spawns `agent --model <model> chat <prompt>` and streams output.
 * Defaults to Cursor Auto (`--model auto`) so usage stays off premium picks.
 *
 * Scans lines for risk patterns; when matched, pauses stdin-side progress
 * by requesting approval (MVP: we emit approval and kill/continue based on decision).
 *
 * Note: Cursor CLI may not expose a true "pause before shell" hook. The MVP
 * scans streamed output for risky command mentions and requests phone approval
 * before allowing the process to continue when dry-run injects such lines;
 * for live runs we still notify Teams and optionally terminate on reject.
 */
export class TaskRunner extends EventEmitter {
  private child: ChildProcessWithoutNullStreams | null = null;
  private killed = false;

  async run(opts: RunTaskOptions): Promise<number> {
    if (opts.dryRun) {
      return this.runDry(opts);
    }

    const model = (opts.agentModel || "auto").trim() || "auto";
    const args = ["--model", model, "chat", opts.prompt];
    this.child = spawn(opts.agentCommand, args, {
      cwd: opts.cwd,
      env: process.env,
      shell: process.platform === "win32",
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
    opts.onLog("stdout", `[dry-run] Would run: agent --model ${model} chat …\n`);
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
