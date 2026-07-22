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
  tenantId?: string;
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

  const tenantId =
    opts.tenantId ??
    (opts.yes
      ? ""
      : await p.text({
          message: "Microsoft Tenant ID (required for Single Tenant bots)",
          placeholder: "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx",
        }));
  if (p.isCancel(tenantId)) return p.cancel("Cancelled");

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
      tenantId: String(tenantId ?? ""),
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

SRC_DIR="$(cd "$(dirname "$0")" && pwd)"

# Quiet noisy sudo hostname warnings when /etc/hosts lacks the short hostname
if ! grep -qE "[[:space:]]$(hostname)(\\s|\$)" /etc/hosts 2>/dev/null; then
  echo "127.0.0.1 $(hostname)" | tee -a /etc/hosts >/dev/null || true
fi

# Prefer sudo only when not already root
run() {
  if [ "$(id -u)" -eq 0 ]; then
    "$@"
  else
    sudo "$@"
  fi
}

# Copy only when source and destination are different paths
safe_cp() {
  local from="\$1" to="\$2"
  if [ ! -f "\$from" ]; then
    echo "Missing: \$from" >&2
    return 1
  fi
  if [ -e "\$to" ] && [ "\$(readlink -f "\$from")" = "\$(readlink -f "\$to")" ]; then
    echo "Already in place: \$to"
    return 0
  fi
  run mkdir -p "\$(dirname "\$to")"
  run cp "\$from" "\$to"
}

run apt-get update -y
run apt-get install -y git curl ca-certificates debian-keyring debian-archive-keyring apt-transport-https gnupg

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
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | run gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | run tee /etc/apt/sources.list.d/caddy-stable.list
  run apt-get update -y
  run apt-get install -y caddy
fi

run mkdir -p /etc/agent-relay /etc/caddy
safe_cp "\$SRC_DIR/config.env" /etc/agent-relay/config.env
run chmod 600 /etc/agent-relay/config.env
safe_cp "\$SRC_DIR/caddy/Caddyfile" /etc/caddy/Caddyfile

NODE_BIN="$(command -v node)"
UNIT_SRC="\$SRC_DIR/systemd/agent-relay-server.service"
UNIT_TMP="$(mktemp)"
sed -E "s|^ExecStart=[^[:space:]]+|ExecStart=\${NODE_BIN}|" "\$UNIT_SRC" > "\$UNIT_TMP"
run cp "\$UNIT_TMP" /etc/systemd/system/agent-relay-server.service
rm -f "\$UNIT_TMP"

run systemctl daemon-reload
run systemctl enable --now agent-relay-server
run systemctl enable --now caddy
run systemctl reload caddy || run systemctl restart caddy
echo "AgentRelay services installed (Node \$(node -v))."
echo "Check: systemctl status agent-relay-server --no-pager"
echo "Health: curl -sS https://\$(grep RELAY_DOMAIN /etc/agent-relay/config.env | cut -d= -f2)/health || curl -sS http://127.0.0.1:3000/health"
`,
    "utf8",
  );

  try {
    chmodSync(join(base, "install-services.sh"), 0o755);
  } catch {
    /* windows */
  }

  p.note(
    [
      `Config:      ${envPath}`,
      `Caddyfile:   ${join(base, "caddy", "Caddyfile")}`,
      `Systemd:     ${join(base, "systemd", "agent-relay-server.service")}`,
      `Teams zip:   ${zipPath}`,
      `Worker token written to config.env (save it for the tray app)`,
      installDry
        ? "Dry-run / Windows: copy install-services.sh to your Linux VM and run it."
        : `Run: bash ${join(base, "install-services.sh")}`,
    ].join("\n"),
    "Wrote files",
  );

  if (!installDry && process.platform === "linux") {
    try {
      execSync(`bash ${join(base, "install-services.sh")}`, {
        stdio: "inherit",
        env: process.env,
      });
    } catch {
      p.log.warn(
        `Could not auto-enable systemd units. Run:\n  bash ${join(base, "install-services.sh")}`,
      );
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
