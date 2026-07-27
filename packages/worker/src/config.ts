import type { ProjectGuardrails } from "@agentr/shared";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";

/** Local agent CLI used to run Teams tasks. */
export type AgentBackend = "cursor" | "codex";

/** Per-project overrides (path required; model/dryRun optional). */
export interface ProjectEntry {
  path: string;
  /** Override global agentModel when set. */
  agentModel?: string;
  /** Override global dryRun when set (true/false). */
  dryRun?: boolean;
  /** Per-project prompt shortcuts for `!alias /run name`. */
  prompts?: Record<string, string>;
  guardrails?: ProjectGuardrails;
}

export interface WorkerConfig {
  relayUrl: string;
  workerToken: string;
  /** Alias → project folder (+ optional per-project defaults). */
  projects: Record<string, ProjectEntry>;
  /** Which CLI to spawn: Cursor `agent` or OpenAI `codex`. */
  agentBackend: AgentBackend;
  agentCommand: string;
  /** Model id for the selected backend (Cursor `auto`, Codex model id, etc.). */
  agentModel: string;
  /** If true, skip spawning real agent and echo the prompt (for tests). */
  dryRun: boolean;
  /** Allow self-signed TLS on WSS (dev only). */
  tlsInsecure?: boolean;
  /** Launch AgentR when Windows starts (tray). */
  openAtLogin?: boolean;
  /** After login / launch, stay in tray (don't open settings). */
  startMinimized?: boolean;
  /** Check GitHub Releases for a newer portable build. */
  checkUpdates?: boolean;
  /** Reject new tasks when Windows session is locked. */
  blockTasksWhenLocked?: boolean;
  /** Prepend git branch/status to agent prompts. */
  includeGitContext?: boolean;
  /** Global max runtime in minutes (0 = off). Overridable per project. */
  maxRuntimeMinutes?: number;
  /** Capture desktop screenshot when approval is requested. */
  approvalScreenshot?: boolean;
  /** Global prompt shortcuts for `!alias /run name`. */
  prompts?: Record<string, string>;
}

export const DEFAULT_CONFIG_DIR = join(homedir(), ".agent-relay");
export const DEFAULT_CONFIG_PATH = join(DEFAULT_CONFIG_DIR, "config.json");

export function defaultCommandForBackend(backend: AgentBackend): string {
  return backend === "codex" ? "codex" : "agent";
}

export function defaultModelForBackend(backend: AgentBackend): string {
  return backend === "codex" ? "gpt-5.4" : "auto";
}

export function parseAgentBackend(value: unknown): AgentBackend {
  return value === "codex" ? "codex" : "cursor";
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

function coerceGuardrails(raw: unknown): ProjectGuardrails | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const g = raw as Record<string, unknown>;
  const out: ProjectGuardrails = {};
  if (typeof g.readOnly === "boolean") out.readOnly = g.readOnly;
  if (typeof g.requireApproval === "boolean") out.requireApproval = g.requireApproval;
  if (typeof g.maxRuntimeMinutes === "number") out.maxRuntimeMinutes = g.maxRuntimeMinutes;
  if (typeof g.blockWhenLocked === "boolean") out.blockWhenLocked = g.blockWhenLocked;
  if (Array.isArray(g.denyPatterns)) {
    out.denyPatterns = g.denyPatterns.filter((x) => typeof x === "string");
  }
  if (Array.isArray(g.allowPatterns)) {
    out.allowPatterns = g.allowPatterns.filter((x) => typeof x === "string");
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function coercePrompts(raw: unknown): Record<string, string> | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof v === "string" && k.trim()) out[k.trim()] = v;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

export function defaultConfig(): WorkerConfig {
  return {
    relayUrl: "wss://agent.example.com/ws",
    workerToken: "",
    projects: {},
    agentBackend: "cursor",
    agentCommand: "agent",
    agentModel: "auto",
    dryRun: false,
    openAtLogin: false,
    startMinimized: true,
    checkUpdates: true,
    blockTasksWhenLocked: true,
    includeGitContext: true,
    maxRuntimeMinutes: 0,
    approvalScreenshot: false,
  };
}

/** Accept legacy `alias → path string` and new `{ path, … }` shapes. */
export function coerceProjects(
  raw: unknown,
): Record<string, ProjectEntry> {
  const out: Record<string, ProjectEntry> = {};
  if (!raw || typeof raw !== "object") return out;
  for (const [alias, value] of Object.entries(
    raw as Record<string, unknown>,
  )) {
    const key = alias.trim();
    if (!key) continue;
    if (typeof value === "string" && value.trim()) {
      out[key] = { path: value.trim() };
      continue;
    }
    if (value && typeof value === "object" && "path" in value) {
      const v = value as {
        path?: unknown;
        agentModel?: unknown;
        dryRun?: unknown;
        prompts?: unknown;
        guardrails?: unknown;
      };
      const path = String(v.path ?? "").trim();
      if (!path) continue;
      const entry: ProjectEntry = { path };
      if (typeof v.agentModel === "string" && v.agentModel.trim()) {
        entry.agentModel = v.agentModel.trim();
      }
      if (typeof v.dryRun === "boolean") entry.dryRun = v.dryRun;
      const prompts = coercePrompts(v.prompts);
      if (prompts) entry.prompts = prompts;
      const guardrails = coerceGuardrails(v.guardrails);
      if (guardrails) entry.guardrails = guardrails;
      out[key] = entry;
    }
  }
  return out;
}

export function projectPath(entry: ProjectEntry | string | undefined): string {
  if (!entry) return "";
  return typeof entry === "string" ? entry : entry.path;
}

export function loadWorkerConfig(path = DEFAULT_CONFIG_PATH): WorkerConfig {
  if (!existsSync(path)) {
    return defaultConfig();
  }
  const raw = JSON.parse(readFileSync(path, "utf8")) as Partial<WorkerConfig> & {
    projects?: unknown;
  };
  const base = defaultConfig();
  const agentBackend = parseAgentBackend(raw.agentBackend ?? base.agentBackend);
  const fallbackCmd = defaultCommandForBackend(agentBackend);
  return {
    ...base,
    ...raw,
    relayUrl: (raw.relayUrl ?? base.relayUrl).trim(),
    workerToken: (raw.workerToken ?? "").trim(),
    agentBackend,
    agentCommand:
      stripOuterQuotes(String(raw.agentCommand ?? fallbackCmd)) || fallbackCmd,
    agentModel:
      (raw.agentModel ?? defaultModelForBackend(agentBackend)).trim() ||
      defaultModelForBackend(agentBackend),
    dryRun: Boolean(raw.dryRun),
    openAtLogin: Boolean(raw.openAtLogin ?? base.openAtLogin),
    startMinimized: Boolean(
      raw.startMinimized !== undefined ? raw.startMinimized : base.startMinimized,
    ),
    checkUpdates: Boolean(
      raw.checkUpdates !== undefined ? raw.checkUpdates : base.checkUpdates,
    ),
    blockTasksWhenLocked: Boolean(
      raw.blockTasksWhenLocked !== undefined
        ? raw.blockTasksWhenLocked
        : base.blockTasksWhenLocked,
    ),
    includeGitContext: Boolean(
      raw.includeGitContext !== undefined
        ? raw.includeGitContext
        : base.includeGitContext,
    ),
    maxRuntimeMinutes: Number(raw.maxRuntimeMinutes ?? base.maxRuntimeMinutes) || 0,
    approvalScreenshot: Boolean(raw.approvalScreenshot ?? base.approvalScreenshot),
    prompts: coercePrompts(raw.prompts) ?? base.prompts,
    projects: coerceProjects(raw.projects),
  };
}

export function saveWorkerConfig(
  config: WorkerConfig,
  path = DEFAULT_CONFIG_PATH,
): void {
  mkdirSync(dirname(path), { recursive: true });
  const projects: Record<string, ProjectEntry> = {};
  for (const [alias, entry] of Object.entries(coerceProjects(config.projects))) {
    const cleaned: ProjectEntry = { path: entry.path };
    if (entry.agentModel?.trim()) cleaned.agentModel = entry.agentModel.trim();
    if (typeof entry.dryRun === "boolean") cleaned.dryRun = entry.dryRun;
    if (entry.prompts && Object.keys(entry.prompts).length > 0) {
      cleaned.prompts = entry.prompts;
    }
    if (entry.guardrails && Object.keys(entry.guardrails).length > 0) {
      cleaned.guardrails = entry.guardrails;
    }
    projects[alias] = cleaned;
  }
  const agentBackend = parseAgentBackend(config.agentBackend);
  const fallbackCmd = defaultCommandForBackend(agentBackend);
  const cleaned: WorkerConfig = {
    ...config,
    relayUrl: config.relayUrl.trim(),
    workerToken: config.workerToken.trim(),
    agentBackend,
    agentCommand:
      stripOuterQuotes(config.agentCommand || fallbackCmd) || fallbackCmd,
    agentModel:
      (config.agentModel || defaultModelForBackend(agentBackend)).trim() ||
      defaultModelForBackend(agentBackend),
    dryRun: Boolean(config.dryRun),
    openAtLogin: Boolean(config.openAtLogin),
    startMinimized: Boolean(config.startMinimized),
    checkUpdates: Boolean(config.checkUpdates),
    blockTasksWhenLocked: Boolean(config.blockTasksWhenLocked),
    includeGitContext: Boolean(config.includeGitContext),
    maxRuntimeMinutes: Number(config.maxRuntimeMinutes) || 0,
    approvalScreenshot: Boolean(config.approvalScreenshot),
    prompts: config.prompts,
    projects,
  };
  writeFileSync(path, JSON.stringify(cleaned, null, 2) + "\n", "utf8");
}

export function ensureConfigDir(): string {
  mkdirSync(DEFAULT_CONFIG_DIR, { recursive: true });
  return DEFAULT_CONFIG_DIR;
}

/** Resolve effective guardrails for a project. */
export function resolveGuardrails(
  _config: WorkerConfig,
  project?: ProjectEntry,
): ProjectGuardrails | undefined {
  const g = project?.guardrails;
  if (!g) return undefined;
  return { ...g };
}

/** Resolve max runtime minutes (project override > global). */
export function resolveMaxRuntimeMinutes(
  config: WorkerConfig,
  project?: ProjectEntry,
): number {
  if (project?.guardrails?.maxRuntimeMinutes) {
    return project.guardrails.maxRuntimeMinutes;
  }
  return config.maxRuntimeMinutes ?? 0;
}
