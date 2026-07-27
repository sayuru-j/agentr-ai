import { execFileSync } from "node:child_process";

export interface GitContext {
  branch?: string;
  dirty: boolean;
  summary: string;
}

const TIMEOUT_MS = 3000;

function git(cwd: string, args: string[]): string {
  try {
    return execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      timeout: TIMEOUT_MS,
      windowsHide: true,
    }).trim();
  } catch {
    return "";
  }
}

/** Lightweight git snapshot for prompt context. */
export function getGitContext(cwd: string): GitContext | null {
  const branch = git(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]);
  if (!branch) return null;

  const status = git(cwd, ["status", "--porcelain"]);
  const dirty = status.length > 0;
  const dirtyCount = status ? status.split(/\r?\n/).filter(Boolean).length : 0;

  let summary = `branch: ${branch}`;
  if (dirty) summary += ` (${dirtyCount} uncommitted change${dirtyCount === 1 ? "" : "s"})`;
  else summary += " (clean)";

  return { branch, dirty, summary };
}

export function formatGitContextBlock(ctx: GitContext): string {
  const lines = ["## Git context", ctx.summary];
  return lines.join("\n") + "\n\n";
}
