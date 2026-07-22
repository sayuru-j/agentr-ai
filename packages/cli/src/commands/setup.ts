import * as p from "@clack/prompts";
import { generateWorkerToken } from "@agentr/shared";
import { existsSync, mkdirSync, writeFileSync, readFileSync, chmodSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";
import pc from "picocolors";
import { buildTeamsAppZip } from "../templates/teams-zip.js";
import {
  renderCaddyfile,
  renderSystemdUnit,
  renderEnvFile,
} from "../templates/render.js";

export interface SetupOptions {
  yes?: boolean;
  dryRun?: boolean;
  domain?: string;
  email?: string;
  appId?: string;
  appSecret?: string;
  out?: string;
}

const __dirname = dirname(fileURLToPath(import.meta.url));

function rootOut(opts: SetupOptions): string {
  if (opts.dryRun || process.platform === "win32") {
    return opts.out ?? join(process.cwd(), "agent-relay-out");
  }
  return "/etc/agent-relay";
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

function checkDeps(): void {
  const nodeOk = which("node");
  const gitOk = which("git");
  const caddyOk = which("caddy");

  p.note(
    [
      `Node.js: ${nodeOk ? pc.green("found") : pc.red("missing")}`,
      `Git:     ${gitOk ? pc.green("found") : pc.red("missing")}`,
      `Caddy:   ${caddyOk ? pc.green("found") : pc.yellow("missing")}`,
    ].join("\n"),
    "Dependencies",
  );

  if (!nodeOk) {
    p.log.error(
      "Install Node.js 20+ first: https://nodejs.org/ or `curl -fsSL https://deb.nodesource.com/setup_20.x | sudo bash`",
    );
    process.exit(1);
  }
  if (!gitOk) {
    p.log.warn("Git not found. Install with: sudo apt install git");
  }
  if (!caddyOk) {
    p.log.warn(
      "Caddy not found. On Debian/Ubuntu:\n  sudo apt install -y debian-keyring debian-archive-keyring apt-transport-https\n  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg\n  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list\n  sudo apt update && sudo apt install caddy",
    );
  }
}

export async function runSetup(opts: SetupOptions): Promise<void> {
  p.intro(pc.bgCyan(pc.black(" AgentRelay setup ")));

  checkDeps();

  const domain =
    opts.domain ??
    (opts.yes
      ? "relay.example.com"
      : await p.text({
          message: "Public domain (DNS A record must point here)",
          placeholder: "relay.example.com",
          validate: (v) => (!v ? "Required" : undefined),
        }));
  if (p.isCancel(domain)) return p.cancel("Cancelled");

  const email =
    opts.email ??
    (opts.yes
      ? "admin@example.com"
      : await p.text({
          message: "Email for Let's Encrypt",
          placeholder: "you@example.com",
          validate: (v) => (!v ? "Required" : undefined),
        }));
  if (p.isCancel(email)) return p.cancel("Cancelled");

  const appId =
    opts.appId ??
    (opts.yes
      ? "00000000-0000-0000-0000-000000000000"
      : await p.text({
          message: "Microsoft Teams App ID (Azure Bot)",
          validate: (v) => (!v ? "Required" : undefined),
        }));
  if (p.isCancel(appId)) return p.cancel("Cancelled");

  const appSecret =
    opts.appSecret ??
    (opts.yes
      ? "replace-me"
      : await p.password({
          message: "Microsoft App Secret",
          validate: (v) => (!v ? "Required" : undefined),
        }));
  if (p.isCancel(appSecret)) return p.cancel("Cancelled");

  const workerToken = generateWorkerToken();
  const base = rootOut(opts);
  const installDry = opts.dryRun || process.platform === "win32";

  mkdirSync(base, { recursive: true });
  mkdirSync(join(base, "caddy"), { recursive: true });
  mkdirSync(join(base, "systemd"), { recursive: true });

  const envPath = join(base, "config.env");
  writeFileSync(
    envPath,
    renderEnvFile({
      appId: String(appId),
      appSecret: String(appSecret),
      workerToken,
      domain: String(domain),
    }),
    "utf8",
  );
  try {
    chmodSync(envPath, 0o600);
  } catch {
    /* windows */
  }

  writeFileSync(
    join(base, "caddy", "Caddyfile"),
    renderCaddyfile({ domain: String(domain), email: String(email) }),
    "utf8",
  );

  const serverEntry = resolveServerEntry();
  writeFileSync(
    join(base, "systemd", "agent-relay-server.service"),
    renderSystemdUnit({
      envFile: installDry ? envPath : "/etc/agent-relay/config.env",
      execStart: `node ${serverEntry}`,
      workingDirectory: dirname(serverEntry),
    }),
    "utf8",
  );

  const zipPath = join(base, "teams-app.zip");
  await buildTeamsAppZip({
    outPath: zipPath,
    appId: String(appId),
    botDomain: String(domain),
    templatesDir: join(__dirname, "..", "templates", "teams"),
  });

  // Also copy a helper install script for Linux
  writeFileSync(
    join(base, "install-services.sh"),
    `#!/usr/bin/env bash
set -euo pipefail
sudo mkdir -p /etc/agent-relay /etc/caddy
sudo cp "$(dirname "$0")/config.env" /etc/agent-relay/config.env
sudo chmod 600 /etc/agent-relay/config.env
sudo cp "$(dirname "$0")/caddy/Caddyfile" /etc/caddy/Caddyfile
sudo cp "$(dirname "$0")/systemd/agent-relay-server.service" /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now agent-relay-server
sudo systemctl reload caddy || sudo systemctl enable --now caddy
echo "AgentRelay services installed."
`,
    "utf8",
  );

  p.note(
    [
      `Config:      ${envPath}`,
      `Caddyfile:   ${join(base, "caddy", "Caddyfile")}`,
      `Systemd:     ${join(base, "systemd", "agent-relay-server.service")}`,
      `Teams zip:   ${zipPath}`,
      `Worker token written to config.env (save it for the tray app)`,
      installDry
        ? "Dry-run / Windows: copy install-services.sh to your Linux VM and run it."
        : "On Linux with sudo, run install-services.sh or enable units manually.",
    ].join("\n"),
    "Wrote files",
  );

  if (!installDry && process.getuid?.() === 0) {
    try {
      execSync(`bash ${join(base, "install-services.sh")}`, { stdio: "inherit" });
    } catch {
      p.log.warn("Could not auto-enable systemd units. Run install-services.sh manually.");
    }
  }

  p.outro(
    pc.green(
      `Done. Upload ${zipPath} to Teams, then configure the worker with this token.`,
    ),
  );
  console.log(pc.dim(`WORKER_TOKEN=${workerToken}`));
}

function resolveServerEntry(): string {
  // Prefer workspace-built server when developing from monorepo
  const candidates = [
    join(__dirname, "..", "..", "..", "server", "dist", "index.js"),
    "/opt/agent-relay/packages/server/dist/index.js",
  ];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  return candidates[0]!;
}

export function readEnvFile(path: string): Record<string, string> {
  if (!existsSync(path)) return {};
  const out: Record<string, string> = {};
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const i = t.indexOf("=");
    if (i < 0) continue;
    out[t.slice(0, i)] = t.slice(i + 1);
  }
  return out;
}
