import { cpSync, mkdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const uiSrc = join(root, "ui");
const uiDest = join(root, "dist", "..", "ui"); // keep ui next to package root for loadFile
// Actually main loads from join(__dirname,'..','ui') = packages/tray/ui — source ui is fine.
// Also copy logo into ui/
const logoCandidates = [
  join(root, "..", "assets", "logo.png"),
  join(root, "assets", "logo.png"),
];

mkdirSync(uiSrc, { recursive: true });
for (const logo of logoCandidates) {
  if (existsSync(logo)) {
    cpSync(logo, join(uiSrc, "logo.png"));
    console.log(`Copied logo → ui/logo.png (${logo})`);
    break;
  }
}

// Ensure dist has a pointer copy of ui for packaged paths if needed
const distUi = join(root, "dist", "ui");
if (existsSync(uiSrc)) {
  mkdirSync(distUi, { recursive: true });
  cpSync(uiSrc, distUi, { recursive: true });
  console.log("Copied tray UI → dist/ui");
}

void uiDest;
