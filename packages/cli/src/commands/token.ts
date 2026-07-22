import { generateWorkerToken } from "@agentr/shared";
import { existsSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import { join } from "node:path";
import pc from "picocolors";

export async function runTokenRotate(opts: { dryRun?: boolean }): Promise<void> {
  const base =
    opts.dryRun || process.platform === "win32"
      ? join(process.cwd(), "agent-relay-out")
      : "/etc/agent-relay";
  const envPath = join(base, "config.env");

  if (!existsSync(envPath)) {
    console.error(`Missing ${envPath}. Run agent-relay setup first.`);
    process.exit(1);
  }

  const token = generateWorkerToken();
  let content = readFileSync(envPath, "utf8");
  if (/^WORKER_TOKEN=.*/m.test(content)) {
    content = content.replace(/^WORKER_TOKEN=.*/m, `WORKER_TOKEN=${token}`);
  } else {
    content += `\nWORKER_TOKEN=${token}\n`;
  }
  writeFileSync(envPath, content, "utf8");
  try {
    chmodSync(envPath, 0o600);
  } catch {
    /* ignore */
  }

  console.log(pc.green("Rotated worker token."));
  console.log(`Updated ${envPath}`);
  console.log(pc.yellow("Restart agent-relay-server and update the tray app config."));
  console.log(`WORKER_TOKEN=${token}`);
}
