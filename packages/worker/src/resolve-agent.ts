import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { execFileSync } from "node:child_process";

export type AgentResolveSource =
  | "config"
  | "path"
  | "localappdata"
  | "missing";

export interface ResolveAgentResult {
  /** Command or absolute path to spawn. */
  command: string;
  found: boolean;
  source: AgentResolveSource;
  /** Human-readable location when found. */
  detail?: string;
}

const WIN_NAMES = ["agent.cmd", "agent.exe", "agent.bat", "agent"];
const POSIX_NAMES = ["agent"];

function looksLikeFilesystemPath(value: string): boolean {
  if (!value) return false;
  if (isAbsolute(value)) return true;
  if (value.includes("/") || value.includes("\\")) return true;
  // Windows drive-relative: C:agent
  if (/^[a-zA-Z]:/.test(value)) return true;
  return false;
}

function firstExisting(paths: string[]): string | null {
  for (const p of paths) {
    if (p && existsSync(p)) return p;
  }
  return null;
}

function findOnPath(names: string[]): string | null {
  if (process.platform === "win32") {
    for (const name of names) {
      try {
        const out = execFileSync("where.exe", [name], {
          encoding: "utf8",
          windowsHide: true,
          timeout: 4000,
        });
        const line = out
          .split(/\r?\n/)
          .map((l) => l.trim())
          .find((l) => l && existsSync(l));
        if (line) return line;
      } catch {
        /* not found */
      }
    }
    return null;
  }

  for (const name of names) {
    try {
      const out = execFileSync("sh", ["-c", `command -v ${JSON.stringify(name)}`], {
        encoding: "utf8",
        timeout: 4000,
      });
      const line = out.trim();
      if (line && existsSync(line)) return line;
    } catch {
      /* not found */
    }
  }
  return null;
}

/** Common Cursor Agent CLI install folders on Windows. */
function cursorAgentCandidateDirs(): string[] {
  const dirs: string[] = [];
  const local = process.env.LOCALAPPDATA?.trim();
  const home = homedir();
  if (local) {
    dirs.push(join(local, "cursor-agent"));
    dirs.push(join(local, "Programs", "cursor-agent"));
  }
  dirs.push(join(home, ".local", "bin"));
  dirs.push(join(home, ".cursor-agent"));
  return dirs;
}

function findInCursorAgentDirs(): string | null {
  const names = process.platform === "win32" ? WIN_NAMES : POSIX_NAMES;
  for (const dir of cursorAgentCandidateDirs()) {
    const hit = firstExisting(names.map((n) => join(dir, n)));
    if (hit) return hit;
    // Some installs nest under versions\<id>\
    const versions = join(dir, "versions");
    if (!existsSync(versions)) continue;
    try {
      for (const ent of readdirSync(versions, { withFileTypes: true })) {
        if (!ent.isDirectory()) continue;
        const nested = firstExisting(
          names.map((n) => join(versions, ent.name, n)),
        );
        if (nested) return nested;
      }
    } catch {
      /* ignore */
    }
  }
  return null;
}

/**
 * Resolve Cursor `agent` CLI for spawn.
 * Prefer an existing configured path; else PATH; else %LOCALAPPDATA%\cursor-agent.
 */
export function resolveAgentCommand(
  configured = "agent",
): ResolveAgentResult {
  const trimmed = configured.trim() || "agent";

  if (looksLikeFilesystemPath(trimmed)) {
    if (existsSync(trimmed)) {
      return {
        command: trimmed,
        found: true,
        source: "config",
        detail: trimmed,
      };
    }
    // Configured path missing — still search defaults
  }

  const names =
    process.platform === "win32" ? WIN_NAMES : [...POSIX_NAMES, trimmed];
  const onPath = findOnPath(
    trimmed !== "agent" && !looksLikeFilesystemPath(trimmed)
      ? [trimmed, ...names]
      : names,
  );
  if (onPath) {
    return {
      command: onPath,
      found: true,
      source: "path",
      detail: onPath,
    };
  }

  const local = findInCursorAgentDirs();
  if (local) {
    return {
      command: local,
      found: true,
      source: "localappdata",
      detail: local,
    };
  }

  return {
    command: looksLikeFilesystemPath(trimmed) ? trimmed : "agent",
    found: false,
    source: "missing",
  };
}

/**
 * If config still says bare `agent` and we can find a real binary, return the path
 * so Electron/portable builds do not depend on a thin GUI PATH.
 */
export function preferResolvedAgentCommand(configured: string): string {
  const trimmed = configured.trim() || "agent";
  if (looksLikeFilesystemPath(trimmed) && existsSync(trimmed)) {
    return trimmed;
  }
  const resolved = resolveAgentCommand(trimmed);
  if (resolved.found && resolved.source !== "config") {
    return resolved.command;
  }
  return trimmed;
}
