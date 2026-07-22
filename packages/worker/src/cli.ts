#!/usr/bin/env node
import { existsSync } from "node:fs";
import {
  DEFAULT_CONFIG_PATH,
  ensureConfigDir,
  loadWorkerConfig,
  saveWorkerConfig,
  defaultConfig,
} from "./config.js";
import { AgentRelayWorker } from "./worker.js";

function usage(): void {
  console.log(`agent-relay-worker

Usage:
  agent-relay-worker [--config <path>] [--dry-run]
  agent-relay-worker init

Environment:
  AGENTR_RELAY_URL   Override relay WebSocket URL
  AGENTR_TOKEN       Override worker token
  AGENTR_DRY_RUN=1   Dry-run mode (no Cursor CLI)
`);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.includes("-h") || args.includes("--help")) {
    usage();
    return;
  }

  if (args[0] === "init") {
    ensureConfigDir();
    if (!existsSync(DEFAULT_CONFIG_PATH)) {
      const cfg = defaultConfig();
      cfg.dryRun = true;
      saveWorkerConfig(cfg);
      console.log(`Wrote ${DEFAULT_CONFIG_PATH}`);
    } else {
      console.log(`Already exists: ${DEFAULT_CONFIG_PATH}`);
    }
    console.log(
      "Edit relayUrl, workerToken, and projects, then re-run the worker.",
    );
    return;
  }

  let configPath = DEFAULT_CONFIG_PATH;
  let dryRunFlag = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--config" && args[i + 1]) {
      configPath = args[++i]!;
    } else if (args[i] === "--dry-run") {
      dryRunFlag = true;
    }
  }

  ensureConfigDir();
  if (!existsSync(configPath)) {
    console.error(
      `Config not found: ${configPath}\nRun: agent-relay-worker init`,
    );
    process.exit(1);
  }

  const config = loadWorkerConfig(configPath);
  if (process.env.AGENTR_RELAY_URL) config.relayUrl = process.env.AGENTR_RELAY_URL;
  if (process.env.AGENTR_TOKEN) config.workerToken = process.env.AGENTR_TOKEN;
  if (dryRunFlag || process.env.AGENTR_DRY_RUN === "1") config.dryRun = true;

  if (!config.workerToken) {
    console.error("workerToken is required in config or AGENTR_TOKEN");
    process.exit(1);
  }

  const worker = new AgentRelayWorker(config);
  worker.on("status", (s) => console.log(`[status] ${s}`));
  worker.on("pairingCode", (c) => console.log(`[pair] Send in Teams: /pair ${c}`));
  worker.on("log", (l) => console.log(`[worker] ${l}`));
  worker.on("error", (e) => console.error(`[error] ${e.message}`));

  worker.start();

  const shutdown = () => {
    console.log("Shutting down…");
    worker.stop();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
