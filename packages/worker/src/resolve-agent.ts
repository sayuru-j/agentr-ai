import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { execFileSync } from "node:child_process";
import {
  type AgentBackend,
  defaultCommandForBackend,
  parseAgentBackend,
} from "./config.js";

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
  backend: AgentBackend;
}

const CURSOR_WIN_NAMES = ["agent.cmd", "agent.exe", "agent.bat", "agent"];
const CURSOR_POSIX_NAMES = ["agent"];
const CODEX_WIN_NAMES = ["codex.cmd", "codex.exe", "codex.bat", "codex"];
const CODEX_POSIX_NAMES = ["codex"];

/** Strip surrounding quotes so config/"Find" paths with spaces still resolve. */
export function stripConfiguredCommand(value: string): string {
  return stripOuterQuotes(value);
}

function stripOuterQuotes(value: string): string {
  const t = value.trim();
  if (
    t.length >= 2 &&
    ((t.startsWith('"') && t.endsWith('"')) ||
      (t.startsWith("'") && t.endsWith("'")))
  ) {
    return t.slice(1, -1).trim();
  }
  return t;
}

function looksLikeFilesystemPath(value: string): boolean {
  if (!value) return false;
  if (isAbsolute(value)) return true;
  if (value.includes("/") || value.includes("\\")) return true;
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

function binaryNames(backend: AgentBackend): string[] {
  if (backend === "codex") {
    return process.platform === "win32" ? CODEX_WIN_NAMES : CODEX_POSIX_NAMES;
  }
  return process.platform === "win32" ? CURSOR_WIN_NAMES : CURSOR_POSIX_NAMES;
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

/** Common Codex CLI install folders. */
function codexCandidateDirs(): string[] {
  const dirs: string[] = [];
  const local = process.env.LOCALAPPDATA?.trim();
  const appData = process.env.APPDATA?.trim();
  const home = homedir();
  if (local) {
    dirs.push(join(local, "Programs", "codex"));
    dirs.push(join(local, "codex"));
  }
  if (appData) {
    dirs.push(join(appData, "npm"));
  }
  dirs.push(join(home, ".local", "bin"));
  dirs.push(join(home, ".codex", "bin"));
  return dirs;
}

function findInDirs(dirs: string[], names: string[]): string | null {
  for (const dir of dirs) {
    const hit = firstExisting(names.map((n) => join(dir, n)));
    if (hit) return hit;
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

function looksLikeCursorAgentPath(command: string): boolean {
  const lower = command.toLowerCase().replace(/\\/g, "/");
  return (
    lower.includes("cursor-agent") ||
    /[/\\]agent\.(cmd|exe|bat)$/i.test(lower)
  );
}

function looksLikeCodexPath(command: string): boolean {
  const lower = command.toLowerCase().replace(/\\/g, "/");
  return /[/\\]codex\.(cmd|exe|bat)$/i.test(lower) || /[/\\]codex$/i.test(lower);
}

/** Reject a configured path that belongs to the other backend. */
export function commandMatchesBackend(
  backend: AgentBackend,
  command: string,
): boolean {
  const trimmed = stripOuterQuotes(command);
  if (!trimmed) return false;

  if (!looksLikeFilesystemPath(trimmed)) {
    const base = trimmed.toLowerCase();
    if (backend === "codex") {
      return base === "codex" || base === "codex.cmd" || base === "codex.exe";
    }
    return base === "agent" || base.startsWith("agent.");
  }

  if (backend === "codex") return !looksLikeCursorAgentPath(trimmed);
  return !looksLikeCodexPath(trimmed) || looksLikeCursorAgentPath(trimmed);
}

function findInInstallDirs(backend: AgentBackend): string | null {
  const names = binaryNames(backend);
  const dirs =
    backend === "codex" ? codexCandidateDirs() : cursorAgentCandidateDirs();
  return findInDirs(dirs, names);
}

/**
 * Resolve agent CLI for spawn (Cursor `agent` or OpenAI `codex`).
 * Prefer an existing configured path; else PATH; else known install dirs.
 */
export function resolveAgentCommand(
  configured = "agent",
  backend: AgentBackend | string = "cursor",
): ResolveAgentResult {
  const resolvedBackend = parseAgentBackend(backend);
  const fallback = defaultCommandForBackend(resolvedBackend);
  const trimmed = stripOuterQuotes(configured) || fallback;
  const names = binaryNames(resolvedBackend);

  if (looksLikeFilesystemPath(trimmed)) {
    if (existsSync(trimmed) && commandMatchesBackend(resolvedBackend, trimmed)) {
      return {
        command: trimmed,
        found: true,
        source: "config",
        detail: trimmed,
        backend: resolvedBackend,
      };
    }
    // Configured path exists but is the wrong CLI for this backend — keep searching.
  }

  const onPath = findOnPath(
    trimmed !== fallback && !looksLikeFilesystemPath(trimmed)
      ? [trimmed, ...names]
      : names,
  );
  if (onPath) {
    return {
      command: onPath,
      found: true,
      source: "path",
      detail: onPath,
      backend: resolvedBackend,
    };
  }

  const local = findInInstallDirs(resolvedBackend);
  if (local) {
    return {
      command: local,
      found: true,
      source: "localappdata",
      detail: local,
      backend: resolvedBackend,
    };
  }

  return {
    command: looksLikeFilesystemPath(trimmed) ? trimmed : fallback,
    found: false,
    source: "missing",
    backend: resolvedBackend,
  };
}

/**
 * If config still says a bare command name and we can find a real binary,
 * return the path so Electron/portable builds do not depend on a thin GUI PATH.
 */
export function preferResolvedAgentCommand(
  configured: string,
  backend: AgentBackend | string = "cursor",
): string {
  const resolvedBackend = parseAgentBackend(backend);
  const fallback = defaultCommandForBackend(resolvedBackend);
  const trimmed = stripOuterQuotes(configured) || fallback;
  if (
    looksLikeFilesystemPath(trimmed) &&
    existsSync(trimmed) &&
    commandMatchesBackend(resolvedBackend, trimmed)
  ) {
    return trimmed;
  }
  const resolved = resolveAgentCommand(trimmed, resolvedBackend);
  if (resolved.found) {
    return resolved.command;
  }
  return fallback;
}
