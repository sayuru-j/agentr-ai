/**
 * For `npm start` / `dev:tray`, remove materialised @agentr copies created by
 * prepare-pack.mjs so Electron resolves the live workspace packages
 * (packages/worker, packages/shared) instead of a stale pack snapshot.
 */
import { existsSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const trayRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const dest = join(trayRoot, "node_modules", "@agentr");

if (existsSync(dest)) {
  rmSync(dest, { recursive: true, force: true });
  console.log("Cleared tray/node_modules/@agentr (using workspace packages)");
}
