import * as p from "@clack/prompts";
import { generateWorkerToken } from "@agentr/shared";
import { existsSync, mkdirSync, writeFileSync, readFileSync, chmodSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";
import pc from "picocolors";
import { ensureDependencies, resolveNodeBinary, NVM_VERSION, NODE_VERSION } from "../deps.js";
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

export async function runSetup(opts: SetupOptions): Promise<void> {
  p.intro(pc.bgCyan(pc.black(" AgentRelay setup ")));

  await ensureDependencies({ yes: opts.yes, dryRun: opts.dryRun });

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
  const nodeBin = installDry ? "node" : resolveNodeBinary();
  writeFileSync(
    join(base, "systemd", "agent-relay-server.service"),
    renderSystemdUnit({
      envFile: installDry ? envPath : "/etc/agent-relay/config.env",
      execStart: `${nodeBin} ${serverEntry}`,
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

sudo apt-get update -y
sudo apt-get install -y git curl ca-certificates debian-keyring debian-archive-keyring apt-transport-https gnupg

# nvm + Node ${NODE_VERSION}
export NVM_DIR="\${NVM_DIR:-\$HOME/.nvm}"
if [ ! -s "\$NVM_DIR/nvm.sh" ]; then
  echo "Installing nvm ${NVM_VERSION}…"
  curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/${NVM_VERSION}/install.sh | bash
fi
# shellcheck disable=SC1090
. "\$NVM_DIR/nvm.sh"
nvm install ${NODE_VERSION}
nvm alias default ${NODE_VERSION}
nvm use ${NODE_VERSION}

# Caddy
if ! command -v caddy >/dev/null 2>&1; then
  echo "Installing Caddy…"
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list
  sudo apt-get update -y
  sudo apt-get install -y caddy
fi

sudo mkdir -p /etc/agent-relay /etc/caddy
sudo cp "$(dirname "$0")/config.env" /etc/agent-relay/config.env
sudo chmod 600 /etc/agent-relay/config.env
sudo cp "$(dirname "$0")/caddy/Caddyfile" /etc/caddy/Caddyfile

# Rewrite ExecStart to absolute nvm node if unit still says bare "node"
NODE_BIN="$(command -v node)"
UNIT_SRC="$(dirname "$0")/systemd/agent-relay-server.service"
UNIT_TMP="$(mktemp)"
sed "s|^ExecStart=node |ExecStart=\${NODE_BIN} |" "\$UNIT_SRC" > "\$UNIT_TMP"
sudo cp "\$UNIT_TMP" /etc/systemd/system/agent-relay-server.service
rm -f "\$UNIT_TMP"

sudo systemctl daemon-reload
sudo systemctl enable --now agent-relay-server
sudo systemctl enable --now caddy
sudo systemctl reload caddy || sudo systemctl restart caddy
echo "AgentRelay services installed (Node \$(node -v))."
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
