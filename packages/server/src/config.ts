import "dotenv/config";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface ServerConfig {
  microsoftAppId: string;
  microsoftAppPassword: string;
  microsoftAppTenantId: string;
  workerToken: string;
  httpPort: number;
  wsPort: number;
  mockMode: boolean;
  /** Public HTTPS origin for artifact URLs, e.g. https://agent.example.com */
  publicBaseUrl: string;
  /** Directory for persisted session data (pairing). */
  dataDir: string;
  /** Path to Teams sideload zip (served at /api/agentr-teams.zip). */
  teamsZipPath: string | null;
}

function resolveTeamsZipPath(): string | null {
  const fromEnv = (process.env.AGENTR_TEAMS_ZIP ?? "").trim();
  if (fromEnv) return fromEnv;
  const candidates = [
    "/etc/agent-relay/agentr-teams.zip",
    join(process.cwd(), "agent-relay-out", "agentr-teams.zip"),
    join(process.cwd(), "agentr-teams.zip"),
  ];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  return candidates[0] ?? null;
}

export function loadConfig(): ServerConfig {
  const microsoftAppId = process.env.MICROSOFT_APP_ID ?? "";
  const microsoftAppPassword = process.env.MICROSOFT_APP_PASSWORD ?? "";
  const mockMode =
    process.env.AGENTR_MOCK === "1" ||
    process.env.AGENTR_MOCK === "true" ||
    (!microsoftAppId && !microsoftAppPassword);

  const domain = (process.env.RELAY_DOMAIN ?? "").trim().replace(/\/$/, "");
  const publicBaseUrl = (
    process.env.PUBLIC_BASE_URL ??
    (domain ? `https://${domain}` : `http://127.0.0.1:${process.env.HTTP_PORT ?? 3000}`)
  ).replace(/\/$/, "");

  const dataDir =
    (process.env.AGENTR_DATA_DIR ?? "").trim() ||
    (process.platform === "win32"
      ? join(homedir(), ".agent-relay-server")
      : "/var/lib/agent-relay");

  return {
    microsoftAppId,
    microsoftAppPassword,
    microsoftAppTenantId: process.env.MICROSOFT_APP_TENANT_ID ?? "",
    workerToken: (process.env.WORKER_TOKEN ?? "").trim(),
    httpPort: Number(process.env.HTTP_PORT ?? 3000),
    wsPort: Number(process.env.WS_PORT ?? 8080),
    mockMode,
    publicBaseUrl,
    dataDir,
    teamsZipPath: resolveTeamsZipPath(),
  };
}
