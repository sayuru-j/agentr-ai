/**
 * Materialize workspace packages under tray/node_modules/@agentr so
 * electron-builder can package them (npm workspace symlinks alone are unreliable).
 */
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const trayRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const packagesRoot = join(trayRoot, "..");
const destRoot = join(trayRoot, "node_modules", "@agentr");

const pkgs = [
  { dir: "shared", name: "@agentr/shared" },
  { dir: "worker", name: "@agentr/worker" },
];

mkdirSync(destRoot, { recursive: true });

for (const { dir, name } of pkgs) {
  const src = join(packagesRoot, dir);
  const dest = join(destRoot, dir);
  const dist = join(src, "dist");
  const pkgJson = join(src, "package.json");

  if (!existsSync(dist)) {
    throw new Error(`${name} has no dist/ — run npm run build first`);
  }
  if (!existsSync(pkgJson)) {
    throw new Error(`Missing ${pkgJson}`);
  }

  rmSync(dest, { recursive: true, force: true });
  mkdirSync(dest, { recursive: true });
  cpSync(pkgJson, join(dest, "package.json"));
  cpSync(dist, join(dest, "dist"), { recursive: true });

  // Drop bin / scripts that confuse packaging; keep exports/main
  const meta = JSON.parse(readFileSync(join(dest, "package.json"), "utf8"));
  delete meta.bin;
  delete meta.scripts;
  delete meta.devDependencies;
  writeFileSync(join(dest, "package.json"), JSON.stringify(meta, null, 2) + "\n");

  console.log(`Prepared ${name} → node_modules/@agentr/${dir}`);
}
