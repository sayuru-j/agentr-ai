import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import pc from "picocolors";
import { execSync } from "node:child_process";
import { readEnvFile } from "./setup.js";

export async function runStatus(opts: { dryRun?: boolean }): Promise<void> {
  const base =
    opts.dryRun || process.platform === "win32"
      ? join(process.cwd(), "agent-relay-out")
      : "/etc/agent-relay";

  const envPath = join(base, "config.env");
  console.log(pc.bold("AgentRelay status"));
  console.log(`Config dir: ${base}`);
  console.log(`config.env: ${existsSync(envPath) ? pc.green("present") : pc.red("missing")}`);

  if (existsSync(envPath)) {
    const env = readEnvFile(envPath);
    console.log(`Domain:     ${env.RELAY_DOMAIN ?? "(unset)"}`);
    console.log(`App ID:     ${env.MICROSOFT_APP_ID ? pc.green("set") : pc.red("missing")}`);
    console.log(`Token:      ${env.WORKER_TOKEN ? pc.green("set") : pc.red("missing")}`);
  }

  if (process.platform !== "win32") {
    try {
      const out = execSync("systemctl is-active agent-relay-server", {
        encoding: "utf8",
      }).trim();
      console.log(`Service:    ${out === "active" ? pc.green(out) : pc.yellow(out)}`);
    } catch {
      console.log(`Service:    ${pc.dim("not installed / inactive")}`);
    }
  }

  const zip = join(base, "agentr-teams.zip");
  console.log(`Teams zip:  ${existsSync(zip) ? zip : pc.dim("not generated")}`);

  // Prefer reading caddyfile existence
  const caddy = join(base, "caddy", "Caddyfile");
  if (existsSync(caddy)) {
    console.log(`Caddyfile:  ${pc.green("present")} (${readFileSync(caddy, "utf8").split("\n")[0]})`);
  }
}
