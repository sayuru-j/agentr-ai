import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";

export interface WorkerConfig {
  relayUrl: string;
  workerToken: string;
  projects: Record<string, string>;
  agentCommand: string;
  /** Cursor CLI `--model` value. Default `auto` (same as Cursor Auto). */
  agentModel: string;
  /** If true, skip spawning real agent and echo the prompt (for tests). */
  dryRun: boolean;
  /** Allow self-signed TLS on WSS (dev only). */
  tlsInsecure?: boolean;
}

export const DEFAULT_CONFIG_DIR = join(homedir(), ".agent-relay");
export const DEFAULT_CONFIG_PATH = join(DEFAULT_CONFIG_DIR, "config.json");

export function defaultConfig(): WorkerConfig {
  return {
    relayUrl: "wss://agent.example.com/ws",
    workerToken: "",
    projects: {},
    agentCommand: "agent",
    agentModel: "auto",
    dryRun: false,
  };
}

export function loadWorkerConfig(path = DEFAULT_CONFIG_PATH): WorkerConfig {
  if (!existsSync(path)) {
    return defaultConfig();
  }
  const raw = JSON.parse(readFileSync(path, "utf8")) as Partial<WorkerConfig>;
  return {
    ...defaultConfig(),
    ...raw,
    relayUrl: (raw.relayUrl ?? defaultConfig().relayUrl).trim(),
    workerToken: (raw.workerToken ?? "").trim(),
    agentCommand: (raw.agentCommand ?? "agent").trim() || "agent",
    agentModel: (raw.agentModel ?? "auto").trim() || "auto",
    projects: raw.projects ?? {},
  };
}

export function saveWorkerConfig(
  config: WorkerConfig,
  path = DEFAULT_CONFIG_PATH,
): void {
  mkdirSync(dirname(path), { recursive: true });
  const cleaned: WorkerConfig = {
    ...config,
    relayUrl: config.relayUrl.trim(),
    workerToken: config.workerToken.trim(),
    agentCommand: (config.agentCommand || "agent").trim(),
    agentModel: (config.agentModel || "auto").trim() || "auto",
  };
  writeFileSync(path, JSON.stringify(cleaned, null, 2) + "\n", "utf8");
}

export function ensureConfigDir(): string {
  mkdirSync(DEFAULT_CONFIG_DIR, { recursive: true });
  return DEFAULT_CONFIG_DIR;
}
