import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";

export interface WorkerConfig {
  relayUrl: string;
  workerToken: string;
  projects: Record<string, string>;
  agentCommand: string;
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
    projects: raw.projects ?? {},
  };
}

export function saveWorkerConfig(
  config: WorkerConfig,
  path = DEFAULT_CONFIG_PATH,
): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(config, null, 2) + "\n", "utf8");
}

export function ensureConfigDir(): string {
  mkdirSync(DEFAULT_CONFIG_DIR, { recursive: true });
  return DEFAULT_CONFIG_DIR;
}
