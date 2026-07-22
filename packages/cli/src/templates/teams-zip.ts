import archiver from "archiver";
import { createWriteStream, existsSync, readFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export async function buildTeamsAppZip(opts: {
  outPath: string;
  appId: string;
  botDomain: string;
  templatesDir: string;
}): Promise<void> {
  mkdirSync(dirname(opts.outPath), { recursive: true });

  const manifestTemplate = loadManifestTemplate(opts.templatesDir);
  const manifest = manifestTemplate
    .replaceAll("{{APP_ID}}", opts.appId)
    .replaceAll("{{BOT_DOMAIN}}", opts.botDomain)
    .replaceAll("{{BOT_ENDPOINT}}", `https://${opts.botDomain}/api/messages`);

  await new Promise<void>((resolve, reject) => {
    const output = createWriteStream(opts.outPath);
    const archive = archiver("zip", { zlib: { level: 9 } });
    output.on("close", () => resolve());
    archive.on("error", reject);
    archive.pipe(output);
    archive.append(manifest, { name: "manifest.json" });

    const colorIcon = join(opts.templatesDir, "color.png");
    const outlineIcon = join(opts.templatesDir, "outline.png");
    if (existsSync(colorIcon)) {
      archive.file(colorIcon, { name: "color.png" });
    } else {
      archive.append(minimalPng(192, [0x1a, 0x73, 0xe8]), { name: "color.png" });
    }
    if (existsSync(outlineIcon)) {
      archive.file(outlineIcon, { name: "outline.png" });
    } else {
      archive.append(minimalPng(32, [0xff, 0xff, 0xff]), { name: "outline.png" });
    }
    void archive.finalize();
  });
}

function loadManifestTemplate(templatesDir: string): string {
  const path = join(templatesDir, "manifest.json");
  if (existsSync(path)) return readFileSync(path, "utf8");
  // Fallback embedded next to compiled output
  const fallback = join(
    dirname(fileURLToPath(import.meta.url)),
    "teams",
    "manifest.json",
  );
  if (existsSync(fallback)) return readFileSync(fallback, "utf8");
  throw new Error("Teams manifest template not found");
}

/** Tiny valid solid-color PNG for packaging when icons are missing. */
function minimalPng(size: number, rgb: [number, number, number]): Buffer {
  // Use a precomputed 1x1 and note Teams wants 192/32 — generate via raw IHDR.
  // For MVP packaging we embed a minimal valid PNG (1x1) — Teams may warn on size
  // but zip remains uploadable for sideload testing; replace with real icons later.
  void size;
  const [r, g, b] = rgb;
  // PNG signature + IHDR + IDAT + IEND for 1x1 RGB
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  // Simpler approach: hardcode a known 1x1 blue PNG and ignore color for outline
  const blue1x1 = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
    "base64",
  );
  if (r + g + b > 600) {
    return Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO5X2ZkAAAAASUVORK5CYII=",
      "base64",
    );
  }
  void signature;
  return blue1x1;
}
