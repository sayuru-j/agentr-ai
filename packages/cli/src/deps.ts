import * as p from "@clack/prompts";
import { execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import pc from "picocolors";

/** Pinned nvm release used by the VM wizard. */
export const NVM_VERSION = "v0.40.6";
/** Node version installed and set as nvm default. */
export const NODE_VERSION = "25.0.0";

export function which(cmd: string): boolean {
  try {
    execSync(
      process.platform === "win32" ? `where ${cmd}` : `command -v ${cmd}`,
      { stdio: "ignore" },
    );
    return true;
  } catch {
    return false;
  }
}

function isRoot(): boolean {
  return typeof process.getuid === "function" && process.getuid() === 0;
}

function sudoPrefix(): string {
  return isRoot() ? "" : "sudo ";
}

function run(cmd: string, opts?: { inherit?: boolean }): string {
  return execSync(cmd, {
    stdio: opts?.inherit === false ? "pipe" : "inherit",
    shell: "/bin/bash",
    encoding: "utf8",
    env: process.env,
  }) as unknown as string;
}

function runCapture(cmd: string): string {
  return execSync(cmd, {
    stdio: ["ignore", "pipe", "pipe"],
    shell: "/bin/bash",
    encoding: "utf8",
    env: process.env,
  }).trim();
}

function detectAptDistro(): "debian" | "ubuntu" | null {
  if (process.platform !== "linux") return null;
  try {
    if (existsSync("/etc/os-release")) {
      const text = readFileSync("/etc/os-release", "utf8");
      if (
        /ID(_LIKE)?=.*(debian|ubuntu)/i.test(text) ||
        /ID="?(debian|ubuntu)/i.test(text)
      ) {
        return /ID=?ubuntu/i.test(text) ? "ubuntu" : "debian";
      }
    }
  } catch {
    /* ignore */
  }
  return which("apt-get") ? "debian" : null;
}

function nvmDir(): string {
  return process.env.NVM_DIR ?? join(homedir(), ".nvm");
}

function nvmSh(): string {
  return join(nvmDir(), "nvm.sh");
}

function hasNvm(): boolean {
  return existsSync(nvmSh());
}

function nodeVersionOk(): boolean {
  if (!which("node")) return false;
  try {
    const v = runCapture("node -v").replace(/^v/, "");
    return v.startsWith("25.0.");
  } catch {
    return false;
  }
}

/** Official Caddy apt install (Debian/Ubuntu). */
export function installCaddyApt(): void {
  const sudo = sudoPrefix();
  const script = `
set -euo pipefail
${sudo}apt-get update -y
${sudo}apt-get install -y debian-keyring debian-archive-keyring apt-transport-https curl gnupg ca-certificates
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | ${sudo}gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | ${sudo}tee /etc/apt/sources.list.d/caddy-stable.list
${sudo}apt-get update -y
${sudo}apt-get install -y caddy
`;
  run(script);
}

export function installGitApt(): void {
  const sudo = sudoPrefix();
  run(
    `${sudo}apt-get update -y && ${sudo}apt-get install -y git curl ca-certificates`,
  );
}

/** Install nvm, then Node NODE_VERSION, and set it as default. */
export function installNvmAndNode(): string {
  const dir = nvmDir();
  const script = `
set -euo pipefail
export NVM_DIR="${dir}"
if [ ! -s "$NVM_DIR/nvm.sh" ]; then
  curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/${NVM_VERSION}/install.sh | bash
fi
# shellcheck disable=SC1090
. "$NVM_DIR/nvm.sh"
nvm install ${NODE_VERSION}
nvm alias default ${NODE_VERSION}
nvm use ${NODE_VERSION}
command -v node
node -v
`;
  const out = runCapture(script);
  const lines = out.split(/\r?\n/).filter(Boolean);
  const nodePath = lines.find((l) => l.includes("/bin/node")) ?? lines[lines.length - 2];
  // Refresh PATH for this process for later which() checks
  const binDir = nodePath ? join(dirnameSafe(nodePath)) : "";
  if (binDir) {
    process.env.PATH = `${binDir}:${process.env.PATH ?? ""}`;
  }
  process.env.NVM_DIR = dir;
  return nodePath ?? runCapture(`. "${nvmSh()}" && command -v node`);
}

function dirnameSafe(filePath: string): string {
  const i = Math.max(filePath.lastIndexOf("/"), filePath.lastIndexOf("\\"));
  return i >= 0 ? filePath.slice(0, i) : filePath;
}

/** Absolute node binary after nvm (for systemd ExecStart). */
export function resolveNodeBinary(): string {
  if (hasNvm()) {
    try {
      return runCapture(
        `export NVM_DIR="${nvmDir()}" && . "$NVM_DIR/nvm.sh" && nvm use ${NODE_VERSION} >/dev/null && command -v node`,
      );
    } catch {
      /* fall through */
    }
  }
  try {
    return runCapture("command -v node");
  } catch {
    return "node";
  }
}

export interface EnsureDepsOptions {
  /** Skip prompts and install when possible */
  yes?: boolean;
  /** Don't run package managers; only report */
  dryRun?: boolean;
}

/**
 * Ensure Git, nvm + Node 25.0.0, and Caddy on Debian/Ubuntu VMs.
 */
export async function ensureDependencies(
  opts: EnsureDepsOptions = {},
): Promise<void> {
  let nodeOk = nodeVersionOk();
  let nvmOk = hasNvm();
  let gitOk = which("git");
  let caddyOk = which("caddy");
  let curlOk = which("curl");

  p.note(
    [
      `Git:     ${gitOk ? pc.green("found") : pc.yellow("missing")}`,
      `curl:    ${curlOk ? pc.green("found") : pc.yellow("missing")}`,
      `nvm:     ${nvmOk ? pc.green("found") : pc.yellow("missing")}`,
      `Node:    ${nodeOk ? pc.green(`v${NODE_VERSION}`) : pc.yellow(`need ${NODE_VERSION}`)}`,
      `Caddy:   ${caddyOk ? pc.green("found") : pc.yellow("missing")}`,
    ].join("\n"),
    "Dependencies",
  );

  const needs: string[] = [];
  if (!gitOk || !curlOk) needs.push("git/curl");
  if (!nvmOk || !nodeOk) needs.push(`nvm + Node ${NODE_VERSION}`);
  if (!caddyOk) needs.push("caddy");

  if (needs.length === 0) {
    p.log.success("All dependencies ready.");
    return;
  }

  if (opts.dryRun || process.platform === "win32") {
    p.log.warn(
      `Would install on Linux VM: ${needs.join(", ")}. ` +
        (process.platform === "win32"
          ? "Skipped on Windows (run setup on the VM)."
          : "Skipped in --dry-run."),
    );
    return;
  }

  const apt = detectAptDistro();
  if (!apt) {
    p.log.error(
      "This wizard auto-installs packages on Debian/Ubuntu only. " +
        "Install git, nvm, Node, and Caddy manually, then re-run.",
    );
    process.exit(1);
  }

  let shouldInstall = opts.yes === true;
  if (!shouldInstall) {
    const answer = await p.confirm({
      message: `Install missing dependencies (${needs.join(", ")})?`,
      initialValue: true,
    });
    if (p.isCancel(answer)) {
      p.cancel("Cancelled");
      process.exit(1);
    }
    shouldInstall = answer;
  }

  if (!shouldInstall) {
    p.log.error("Cannot continue without required dependencies.");
    process.exit(1);
  }

  if (!isRoot() && !which("sudo")) {
    p.log.error("Need root or sudo to install apt packages (git/curl/caddy).");
    process.exit(1);
  }

  const spin = p.spinner();

  // git + curl first (nvm installer needs curl)
  if (!gitOk || !curlOk) {
    spin.start("Installing git and curl…");
    try {
      installGitApt();
      gitOk = which("git");
      curlOk = which("curl");
      spin.stop(
        `git ${gitOk ? "ok" : "missing"}, curl ${curlOk ? "ok" : "missing"}`,
      );
    } catch (err) {
      spin.stop("git/curl install failed");
      p.log.error(String(err instanceof Error ? err.message : err));
      process.exit(1);
    }
  }

  if (!curlOk) {
    p.log.error("curl is required to install nvm.");
    process.exit(1);
  }

  if (!nvmOk || !nodeOk) {
    spin.start(
      `Installing nvm ${NVM_VERSION} and Node ${NODE_VERSION} (default)…`,
    );
    try {
      const nodePath = installNvmAndNode();
      nvmOk = hasNvm();
      nodeOk = nodeVersionOk() || Boolean(nodePath);
      spin.stop(`Node ready at ${nodePath}`);
    } catch (err) {
      spin.stop("nvm/Node install failed");
      p.log.error(String(err instanceof Error ? err.message : err));
      p.log.info(
        `Manual:\n  curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/${NVM_VERSION}/install.sh | bash\n  nvm install ${NODE_VERSION} && nvm alias default ${NODE_VERSION}`,
      );
      process.exit(1);
    }
  }

  if (!caddyOk) {
    spin.start("Installing Caddy (official apt repo)…");
    try {
      installCaddyApt();
      caddyOk = which("caddy");
      if (!caddyOk) {
        throw new Error("caddy binary not found on PATH after install");
      }
      spin.stop(
        `Caddy installed (${runCapture("caddy version")})`,
      );
    } catch (err) {
      spin.stop("Caddy install failed");
      p.log.error(String(err instanceof Error ? err.message : err));
      p.log.info(
        "Manual install: https://caddyserver.com/docs/install#debian-ubuntu-raspbian",
      );
      process.exit(1);
    }
  }

  p.note(
    [
      `Git:     ${gitOk ? pc.green("found") : pc.red("missing")}`,
      `nvm:     ${nvmOk ? pc.green(NVM_VERSION) : pc.red("missing")}`,
      `Node:    ${pc.green(runCapture("node -v") || NODE_VERSION)}`,
      `Caddy:   ${caddyOk ? pc.green("found") : pc.red("missing")}`,
    ].join("\n"),
    "Dependencies (after install)",
  );
}
