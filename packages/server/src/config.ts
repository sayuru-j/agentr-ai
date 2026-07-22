import "dotenv/config";

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

  return {
    microsoftAppId,
    microsoftAppPassword,
    microsoftAppTenantId: process.env.MICROSOFT_APP_TENANT_ID ?? "",
    workerToken: (process.env.WORKER_TOKEN ?? "").trim(),
    httpPort: Number(process.env.HTTP_PORT ?? 3000),
    wsPort: Number(process.env.WS_PORT ?? 8080),
    mockMode,
    publicBaseUrl,
  };
}
