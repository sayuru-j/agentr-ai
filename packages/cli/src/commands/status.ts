import { existsSync, readFileSync, statSync, copyFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pc from "picocolors";
import { execSync, spawnSync } from "node:child_process";
import * as p from "@clack/prompts";
import { readEnvFile } from "./setup.js";
import { runTokenRotate } from "./token.js";
import {
  buildTeamsAppZip,
  bumpTeamsAppVersion,
  DEFAULT_TEAMS_APP_VERSION,
  readTeamsAppVersionFile,
  writeTeamsAppVersionFile,
} from "../templates/teams-zip.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

interface HealthPayload {
  ok?: boolean;
  mockMode?: boolean;
  workerOnline?: boolean;
  worker?: { hostname?: string; repos?: string[] } | null;
  pairedUsers?: number;
  pairingCode?: string;
}

export type StatusAction =
  | "reload-caddy"
  | "restart-caddy"
  | "restart-relay"
  | "restart-all"
  | "sync-caddyfile"
  | "rebuild-teams-zip"
  | "logs-relay"
  | "logs-caddy"
  | "show-token"
  | "show-pair"
  | "health"
  | "rotate-token"
  | "install-services"
  | "refresh"
  | "exit";

export interface StatusOptions {
  dryRun?: boolean;
  /** Skip interactive menu after report */
  noMenu?: boolean;
  /** Run a single action non-interactively */
  action?: StatusAction;
}

function maskSecret(value: string | undefined): string {
  if (!value) return pc.red("missing");
  if (value.length <= 8) return pc.green("set");
  return pc.green(`set (${value.slice(0, 4)}…${value.slice(-4)})`);
}

function systemdState(unit: string): { active: string; enabled: string } {
  let active = "unknown";
  let enabled = "unknown";
  try {
    active = execSync(`systemctl is-active ${unit}`, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch (err) {
    active =
      typeof err === "object" &&
      err &&
      "stdout" in err &&
      typeof (err as { stdout?: Buffer | string }).stdout !== "undefined"
        ? String((err as { stdout: Buffer | string }).stdout).trim() || "inactive"
        : "inactive";
  }
  try {
    enabled = execSync(`systemctl is-enabled ${unit}`, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    enabled = "disabled";
  }
  return { active, enabled };
}

function colorState(state: string): string {
  if (state === "active" || state === "enabled") return pc.green(state);
  if (state === "activating" || state === "reloading") return pc.yellow(state);
  if (state === "inactive" || state === "failed" || state === "disabled") {
    return pc.red(state);
  }
  return pc.dim(state);
}

function which(cmd: string): boolean {
  try {
    execSync(process.platform === "win32" ? `where ${cmd}` : `command -v ${cmd}`, {
      stdio: "ignore",
    });
    return true;
  } catch {
    return false;
  }
}

function nodeVersion(): string {
  try {
    return execSync("node -v", { encoding: "utf8" }).trim();
  } catch {
    return "missing";
  }
}

async function fetchJson(url: string, timeoutMs = 4000): Promise<{
  ok: boolean;
  status?: number;
  body?: HealthPayload;
  error?: string;
}> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    const text = await res.text();
    let body: HealthPayload | undefined;
    try {
      body = JSON.parse(text) as HealthPayload;
    } catch {
      body = undefined;
    }
    return { ok: res.ok, status: res.status, body };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  } finally {
    clearTimeout(timer);
  }
}

function line(label: string, value: string, width = 14): void {
  console.log(`${pc.dim(label.padEnd(width))} ${value}`);
}

function section(title: string): void {
  console.log();
  console.log(
    pc.bold(pc.cyan(`── ${title} `)) +
      pc.dim("─".repeat(Math.max(8, 40 - title.length))),
  );
}

function fileInfo(path: string): string {
  if (!existsSync(path)) return pc.red("missing");
  try {
    const st = statSync(path);
    const kb = Math.max(1, Math.round(st.size / 1024));
    return pc.green("ok") + pc.dim(` (${kb} KB)`);
  } catch {
    return pc.yellow("unreadable");
  }
}

function runShell(cmd: string, opts?: { dryRun?: boolean; label?: string }): boolean {
  const label = opts?.label ?? cmd;
  if (opts?.dryRun || process.platform === "win32") {
    p.log.warn(`[dry-run / non-Linux] would run: ${cmd}`);
    return true;
  }
  const spin = p.spinner();
  spin.start(label);
  try {
    execSync(cmd, { stdio: ["ignore", "pipe", "pipe"], encoding: "utf8" });
    spin.stop(pc.green(label));
    return true;
  } catch (err) {
    spin.stop(pc.red(`Failed: ${label}`));
    const msg =
      err && typeof err === "object" && "stderr" in err
        ? String((err as { stderr: string }).stderr || (err as { message?: string }).message)
        : String(err);
    p.log.error(msg.trim() || "command failed");
    return false;
  }
}

function showLogs(unit: string, lines = 40): void {
  if (process.platform === "win32") {
    p.log.warn("Logs require systemd on the Linux VM.");
    return;
  }
  console.log();
  console.log(pc.bold(`journalctl -u ${unit} -n ${lines}`));
  console.log(pc.dim("─".repeat(48)));
  spawnSync("journalctl", ["-u", unit, "-n", String(lines), "--no-pager"], {
    stdio: "inherit",
  });
  console.log();
}

interface StatusContext {
  base: string;
  envPath: string;
  env: Record<string, string>;
  domain: string;
  zip: string;
  versionFile: string;
  httpPort: string;
  dryRun: boolean;
}

function resolveContext(opts: StatusOptions): StatusContext {
  const base =
    opts.dryRun || process.platform === "win32"
      ? join(process.cwd(), "agent-relay-out")
      : "/etc/agent-relay";
  const envPath = join(base, "config.env");
  const env = existsSync(envPath) ? readEnvFile(envPath) : {};
  return {
    base,
    envPath,
    env,
    domain: env.RELAY_DOMAIN ?? "",
    zip: join(base, "agentr-teams.zip"),
    versionFile: join(base, "teams-app.version"),
    httpPort: env.HTTP_PORT ?? "3000",
    dryRun: Boolean(opts.dryRun) || process.platform === "win32",
  };
}

async function printReport(ctx: StatusContext): Promise<{
  pairing?: string;
  workerOnline: boolean;
}> {
  const { base, envPath, env, domain, zip, httpPort } = ctx;
  const caddySrc = join(base, "caddy", "Caddyfile");
  const caddyLive = "/etc/caddy/Caddyfile";

  console.log();
  console.log(pc.bold(pc.bgCyan(pc.black(" AgentR status "))));
  console.log(pc.dim(`Config: ${base}${ctx.dryRun ? " (dry-run / local)" : ""}`));

  section("Configuration");
  line("config.env", existsSync(envPath) ? pc.green("present") : pc.red("missing"));
  line("Domain", domain ? pc.bold(domain) : pc.red("unset"));
  line("App ID", maskSecret(env.MICROSOFT_APP_ID));
  line(
    "Tenant ID",
    env.MICROSOFT_APP_TENANT_ID
      ? maskSecret(env.MICROSOFT_APP_TENANT_ID)
      : pc.yellow("empty (required for Single Tenant)"),
  );
  line("App secret", env.MICROSOFT_APP_PASSWORD ? pc.green("set") : pc.red("missing"));
  line("Worker token", maskSecret(env.WORKER_TOKEN));
  line("HTTP port", httpPort);
  line("WS port", env.WS_PORT ?? "8080");
  line(
    "Mock mode",
    env.AGENTR_MOCK === "1" || env.AGENTR_MOCK === "true"
      ? pc.yellow("ON (Teams auth skipped)")
      : pc.green("off"),
  );

  section("Runtime");
  line("Node", which("node") ? pc.green(nodeVersion()) : pc.red("missing"));
  line("Caddy bin", which("caddy") ? pc.green("found") : pc.red("missing"));
  line("Git", which("git") ? pc.green("found") : pc.yellow("missing"));
  if (which("caddy")) {
    try {
      const ver =
        execSync("caddy version", { encoding: "utf8" }).trim().split(/\s+/)[0] ?? "";
      line("Caddy ver", pc.dim(ver));
    } catch {
      /* ignore */
    }
  }

  section("Services");
  if (process.platform === "win32") {
    line("systemd", pc.dim("n/a on Windows — check the Linux VM"));
  } else {
    const relay = systemdState("agent-relay-server");
    const caddy = systemdState("caddy");
    line("relay", `${colorState(relay.active)} · ${colorState(relay.enabled)}`);
    line("caddy", `${colorState(caddy.active)} · ${colorState(caddy.enabled)}`);
  }

  section("Artifacts");
  line("Teams zip", fileInfo(zip) + (existsSync(zip) ? pc.dim(`  ${zip}`) : ""));
  const storedVersion = readTeamsAppVersionFile(ctx.versionFile);
  if (storedVersion) {
    line("App version", pc.bold(storedVersion));
  } else if (existsSync(zip)) {
    line("App version", pc.dim("unknown — rebuild to set"));
  }
  if (existsSync(zip) && domain) {
    line("Download", pc.bold(`https://${domain}/api/agentr-teams.zip`));
  } else if (existsSync(zip)) {
    line(
      "Download",
      pc.dim(`http://127.0.0.1:${httpPort}/api/agentr-teams.zip`) +
        pc.dim(" (set RELAY_DOMAIN for public HTTPS link)"),
    );
  }
  line("Caddyfile", fileInfo(existsSync(caddyLive) ? caddyLive : caddySrc));
  if (existsSync(caddySrc) || existsSync(caddyLive)) {
    const path = existsSync(caddyLive) ? caddyLive : caddySrc;
    const firstSite = readFileSync(path, "utf8")
      .split(/\r?\n/)
      .map((l) => l.trim())
      .find(
        (l) =>
          l && !l.startsWith("{") && !l.startsWith("#") && !l.startsWith("email"),
      );
    if (firstSite) {
      line("Site block", pc.dim(firstSite.replace(/\{.*/, "").trim() || firstSite));
    }
  }

  section("Live health");
  const local = await fetchJson(`http://127.0.0.1:${httpPort}/health`);
  let workerOnline = false;
  if (local.ok && local.body) {
    workerOnline = Boolean(local.body.workerOnline);
    line("Local HTTP", pc.green(`ok :${httpPort}/health`));
    line(
      "Worker",
      workerOnline
        ? pc.green(`online (${local.body.worker?.hostname ?? "pc"})`)
        : pc.yellow("offline — start the AgentR tray on your PC"),
    );
    if (local.body.worker?.repos?.length) {
      line("Projects", local.body.worker.repos.join(", "));
    }
    line("Paired users", String(local.body.pairedUsers ?? 0));
    line("Mock", local.body.mockMode ? pc.yellow("true") : pc.green("false"));
  } else {
    line(
      "Local HTTP",
      pc.red("down") +
        pc.dim(
          local.error
            ? ` (${local.error})`
            : ` (HTTP ${local.status ?? "?"}) — is agent-relay-server running?`,
        ),
    );
  }

  let pairing: string | undefined;
  if (local.ok) {
    const pairRes = await fetchJson(`http://127.0.0.1:${httpPort}/api/pairing-code`);
    pairing = pairRes.body?.pairingCode;
    if (pairing) line("Pair code", pc.bold(`/pair ${pairing}`));
  }

  if (domain) {
    const https = await fetchJson(`https://${domain}/health`);
    if (https.ok && https.body?.ok) {
      line("Public HTTPS", pc.green(`https://${domain}/health`));
      line("Public WSS", pc.green(`wss://${domain}/ws`));
    } else {
      line(
        "Public HTTPS",
        pc.red("fail") +
          pc.dim(
            https.error
              ? ` — ${https.error}`
              : ` — HTTP ${https.status ?? "?"} (DNS / NSG 80+443 / Caddy cert?)`,
          ),
      );
    }
  } else {
    line("Public HTTPS", pc.dim("skipped (no RELAY_DOMAIN)"));
  }

  section("Next steps");
  const tips: string[] = [];
  if (!existsSync(envPath)) tips.push("Run: npm run cli:setup");
  if (process.platform !== "win32") {
    const relay = systemdState("agent-relay-server");
    if (relay.active !== "active") {
      tips.push("Start relay: choose “Restart relay” below, or systemctl start agent-relay-server");
    }
  }
  if (local.ok && !workerOnline) {
    tips.push("On your PC: npm run dev:tray → paste worker token → Save & connect");
  }
  if (pairing && workerOnline) {
    tips.push(`In Teams: /pair ${pairing}`);
  } else if (existsSync(zip)) {
    tips.push(
      domain
        ? `Sideload Teams app: https://${domain}/api/agentr-teams.zip`
        : `Sideload Teams app: ${zip}`,
    );
  }
  if (domain) {
    tips.push(`Azure Bot endpoint: https://${domain}/api/messages`);
  }
  tips.push("Pick an action below, or see docs/troubleshooting.md");

  for (const [i, tip] of tips.entries()) {
    console.log(`  ${pc.dim(`${i + 1}.`)} ${tip}`);
  }
  console.log();

  return { pairing, workerOnline };
}

async function runAction(
  action: StatusAction,
  ctx: StatusContext,
  pairing?: string,
): Promise<"refresh" | "done" | "continue"> {
  const dry = { dryRun: ctx.dryRun };

  switch (action) {
    case "exit":
      return "done";

    case "refresh":
      return "refresh";

    case "reload-caddy":
      runShell("systemctl reload caddy", { ...dry, label: "Reloading Caddy" });
      return "continue";

    case "restart-caddy":
      runShell("systemctl restart caddy", { ...dry, label: "Restarting Caddy" });
      return "continue";

    case "restart-relay":
      runShell("systemctl restart agent-relay-server", {
        ...dry,
        label: "Restarting agent-relay-server",
      });
      return "continue";

    case "restart-all":
      runShell("systemctl restart agent-relay-server", {
        ...dry,
        label: "Restarting agent-relay-server",
      });
      runShell("systemctl restart caddy", { ...dry, label: "Restarting Caddy" });
      return "continue";

    case "sync-caddyfile": {
      const src = join(ctx.base, "caddy", "Caddyfile");
      const dest = "/etc/caddy/Caddyfile";
      if (!existsSync(src)) {
        p.log.error(`Missing ${src}`);
        return "continue";
      }
      if (ctx.dryRun) {
        p.log.warn(`[dry-run] would copy ${src} → ${dest} and reload caddy`);
        return "continue";
      }
      try {
        copyFileSync(src, dest);
        p.log.success(`Copied Caddyfile → ${dest}`);
        runShell("systemctl reload caddy", { label: "Reloading Caddy" });
      } catch (err) {
        p.log.error(String(err instanceof Error ? err.message : err));
      }
      return "continue";
    }

    case "rebuild-teams-zip": {
      const appId = (ctx.env.MICROSOFT_APP_ID ?? "").trim();
      const domain = (ctx.domain ?? "").trim();
      if (!appId) {
        p.log.error("MICROSOFT_APP_ID missing in config.env — run setup first");
        return "continue";
      }
      if (!domain) {
        p.log.error("RELAY_DOMAIN missing in config.env — run setup first");
        return "continue";
      }
      const prev =
        readTeamsAppVersionFile(ctx.versionFile) ?? DEFAULT_TEAMS_APP_VERSION;
      const next = bumpTeamsAppVersion(prev);
      try {
        const spinner = p.spinner();
        spinner.start(`Building agentr-teams.zip (v${next})…`);
        const built = await buildTeamsAppZip({
          outPath: ctx.zip,
          appId,
          botDomain: domain,
          templatesDir: join(__dirname, "..", "templates", "teams"),
          version: next,
        });
        writeTeamsAppVersionFile(ctx.versionFile, built.version);
        spinner.stop(`Wrote ${ctx.zip}`);
        const download = domain
          ? `https://${domain}/api/agentr-teams.zip`
          : `http://127.0.0.1:${ctx.httpPort}/api/agentr-teams.zip`;
        p.note(
          [
            `Version:  ${built.version} (was ${prev})`,
            `Logo:     ${built.logoPath ?? "fallback template icons"}`,
            `Zip:      ${ctx.zip}`,
            `Download: ${download}`,
            "",
            "In Teams: remove the old app (or update), then upload this zip again.",
            "Icon changes need a higher manifest version — already bumped.",
          ].join("\n"),
          "Teams app rebuilt",
        );
      } catch (err) {
        p.log.error(String(err instanceof Error ? err.message : err));
      }
      return "continue";
    }

    case "logs-relay":
      showLogs("agent-relay-server");
      return "continue";

    case "logs-caddy":
      showLogs("caddy");
      return "continue";

    case "show-token":
      if (!ctx.env.WORKER_TOKEN) {
        p.log.error("WORKER_TOKEN not set in config.env");
      } else {
        p.note(
          [
            ctx.env.WORKER_TOKEN,
            "",
            `Tray relay URL: wss://${ctx.domain || "YOUR_DOMAIN"}/ws`,
          ].join("\n"),
          "Worker token (paste into AgentR tray)",
        );
      }
      return "continue";

    case "show-pair": {
      let code = pairing;
      if (!code) {
        const res = await fetchJson(
          `http://127.0.0.1:${ctx.httpPort}/api/pairing-code`,
        );
        code = res.body?.pairingCode;
      }
      if (code) {
        p.note(`/pair ${code}`, "Send this in Teams");
      } else {
        p.log.warn("Pairing code unavailable — is the relay running?");
      }
      return "continue";
    }

    case "health": {
      const local = await fetchJson(`http://127.0.0.1:${ctx.httpPort}/health`);
      const https = ctx.domain
        ? await fetchJson(`https://${ctx.domain}/health`)
        : null;
      p.note(
        [
          `Local:  ${local.ok ? "ok" : "FAIL"} ${local.error ?? JSON.stringify(local.body) ?? ""}`,
          ctx.domain
            ? `Public: ${https?.ok ? "ok" : "FAIL"} ${https?.error ?? JSON.stringify(https?.body) ?? ""}`
            : "Public: (no domain)",
          local.body?.workerOnline
            ? `Worker: online (${local.body.worker?.hostname})`
            : "Worker: offline",
        ].join("\n"),
        "Health check",
      );
      return "continue";
    }

    case "rotate-token":
      await runTokenRotate({ dryRun: ctx.dryRun });
      p.log.warn("Restart the relay and update the AgentR tray token.");
      return "continue";

    case "install-services": {
      const script = join(ctx.base, "install-services.sh");
      if (!existsSync(script)) {
        p.log.error(`Missing ${script} — run setup first`);
        return "continue";
      }
      runShell(`bash ${script}`, { ...dry, label: "Running install-services.sh" });
      return "continue";
    }

    default:
      p.log.warn(`Unknown action: ${action}`);
      return "continue";
  }
}

async function promptAction(): Promise<StatusAction | symbol> {
  return p.select({
    message: "Manage AgentR",
    options: [
      { value: "reload-caddy", label: "Reload Caddy", hint: "pick up Caddyfile / retry certs" },
      { value: "restart-caddy", label: "Restart Caddy" },
      { value: "restart-relay", label: "Restart relay server" },
      { value: "restart-all", label: "Restart relay + Caddy" },
      {
        value: "sync-caddyfile",
        label: "Sync Caddyfile → /etc/caddy + reload",
      },
      {
        value: "rebuild-teams-zip",
        label: "Rebuild Teams app zip",
        hint: "icons / logo → bump version + download link",
      },
      { value: "logs-relay", label: "Show relay logs", hint: "last 40 lines" },
      { value: "logs-caddy", label: "Show Caddy logs", hint: "last 40 lines" },
      { value: "health", label: "Re-check health (local + public)" },
      { value: "show-pair", label: "Show pairing command" },
      { value: "show-token", label: "Show worker token", hint: "for tray paste" },
      { value: "rotate-token", label: "Rotate worker token" },
      { value: "install-services", label: "Re-run install-services.sh" },
      { value: "refresh", label: "Refresh status report" },
      { value: "exit", label: "Exit" },
    ],
  }) as Promise<StatusAction | symbol>;
}

export async function runStatus(opts: StatusOptions = {}): Promise<void> {
  let ctx = resolveContext(opts);

  // Non-interactive single action
  if (opts.action && opts.action !== "refresh") {
    await printReport(ctx);
    await runAction(opts.action, ctx);
    return;
  }

  // Report + optional menu loop
  for (;;) {
    ctx = resolveContext(opts);
    const { pairing } = await printReport(ctx);

    if (opts.noMenu || opts.action === "refresh") {
      if (opts.action === "refresh") {
        /* one-shot refresh already printed */
      }
      return;
    }

    // Only show menu when stdin is a TTY
    if (!process.stdin.isTTY) {
      console.log(
        pc.dim(
          "Tip: run interactively for actions, or: npm run cli -- status --action reload-caddy",
        ),
      );
      return;
    }

    const choice = await promptAction();
    if (p.isCancel(choice)) {
      p.cancel("Bye");
      return;
    }

    const result = await runAction(choice, ctx, pairing);
    if (result === "done") {
      p.outro("Done");
      return;
    }
    if (result === "refresh") {
      continue;
    }
    // continue → show menu again after a short separator
    console.log(pc.dim("─".repeat(48)));
  }
}
