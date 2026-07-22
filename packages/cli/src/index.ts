#!/usr/bin/env node
import { Command } from "commander";
import { runSetup } from "./commands/setup.js";
import { runStatus } from "./commands/status.js";
import { runTokenRotate } from "./commands/token.js";

const program = new Command();

program
  .name("agent-relay")
  .description("AgentRelay VM provisioning and management CLI")
  .version("0.1.0");

program
  .command("setup")
  .description("Interactive wizard: SSL, env, systemd, Teams app zip")
  .option("-y, --yes", "Non-interactive defaults where possible", false)
  .option("--dry-run", "Write files under ./agent-relay-out instead of /etc", false)
  .option("--domain <domain>", "Public domain for the relay")
  .option("--email <email>", "ACME / Let's Encrypt email")
  .option("--app-id <id>", "Microsoft App ID")
  .option("--app-secret <secret>", "Microsoft App Secret")
  .option("--tenant-id <id>", "Microsoft Tenant ID (Single Tenant)")
  .option("--out <dir>", "Output directory for dry-run / teams zip")
  .action(async (opts) => {
    await runSetup({
      yes: opts.yes,
      dryRun: opts.dryRun,
      domain: opts.domain,
      email: opts.email,
      appId: opts.appId,
      appSecret: opts.appSecret,
      tenantId: opts.tenantId,
      out: opts.out,
    });
  });

program
  .command("status")
  .description("Show relay status and manage services (reload Caddy, logs, …)")
  .option("--dry-run", "Look at ./agent-relay-out instead of /etc", false)
  .option("--no-menu", "Print status only (no action menu)", false)
  .option(
    "--action <name>",
    "Run one action: reload-caddy|restart-caddy|restart-relay|restart-all|sync-caddyfile|logs-relay|logs-caddy|health|show-pair|show-token|rotate-token|install-services|refresh",
  )
  .action(async (opts) => {
    await runStatus({
      dryRun: opts.dryRun,
      noMenu: opts.noMenu,
      action: opts.action,
    });
  });

const tokenCmd = program
  .command("token")
  .description("Worker token utilities");

tokenCmd
  .command("rotate")
  .description("Generate a new worker token and update config.env")
  .option("--dry-run", "Update ./agent-relay-out instead of /etc", false)
  .action(async (opts) => {
    await runTokenRotate(opts);
  });

program.parseAsync(process.argv).catch((err) => {
  console.error(err);
  process.exit(1);
});
