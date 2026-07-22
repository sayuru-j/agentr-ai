import { cpSync, mkdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const assets = join(root, "assets");
const dest = join(root, "dist", "assets");
if (existsSync(assets)) {
  mkdirSync(dest, { recursive: true });
  cpSync(assets, dest, { recursive: true });
  console.log("Copied tray assets");
} else {
  console.log("No tray assets to copy");
}
