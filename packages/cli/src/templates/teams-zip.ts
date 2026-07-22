import archiver from "archiver";
import { createWriteStream, existsSync, readFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Jimp } from "jimp";

export async function buildTeamsAppZip(opts: {
  outPath: string;
  appId: string;
  botDomain: string;
  templatesDir: string;
  logoPath?: string;
}): Promise<void> {
  mkdirSync(dirname(opts.outPath), { recursive: true });

  const manifestTemplate = loadManifestTemplate(opts.templatesDir);
  const manifest = manifestTemplate
    .replaceAll("{{APP_ID}}", opts.appId)
    .replaceAll("{{BOT_DOMAIN}}", opts.botDomain)
    .replaceAll("{{BOT_ENDPOINT}}", `https://${opts.botDomain}/api/messages`);

  const logoPath = opts.logoPath ?? resolveDefaultLogoPath();
  const { colorPng, outlinePng } = await loadIcons(logoPath, opts.templatesDir);

  await new Promise<void>((resolve, reject) => {
    const output = createWriteStream(opts.outPath);
    const archive = archiver("zip", { zlib: { level: 9 } });
    output.on("close", () => resolve());
    archive.on("error", reject);
    archive.pipe(output);
    archive.append(manifest, { name: "manifest.json" });
    archive.append(colorPng, { name: "color.png" });
    archive.append(outlinePng, { name: "outline.png" });
    void archive.finalize();
  });
}

function resolveDefaultLogoPath(): string {
  // packages/cli/dist/templates → ../../../../assets/logo.png
  const candidates = [
    join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "assets", "logo.png"),
    join(process.cwd(), "packages", "assets", "logo.png"),
    join(process.cwd(), "assets", "logo.png"),
  ];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  return candidates[0]!;
}

async function loadIcons(
  logoPath: string,
  templatesDir: string,
): Promise<{ colorPng: Buffer; outlinePng: Buffer }> {
  if (existsSync(logoPath)) {
    const colorPng = await resizePng(logoPath, 192);
    const outlinePng = await makeOutlinePng(logoPath, 32);
    return { colorPng, outlinePng };
  }

  const colorIcon = join(templatesDir, "color.png");
  const outlineIcon = join(templatesDir, "outline.png");
  return {
    colorPng: existsSync(colorIcon)
      ? readFileSync(colorIcon)
      : minimalPng(),
    outlinePng: existsSync(outlineIcon)
      ? readFileSync(outlineIcon)
      : minimalPng(),
  };
}

async function resizePng(path: string, size: number): Promise<Buffer> {
  const image = await Jimp.read(path);
  image.resize({ w: size, h: size });
  return Buffer.from(await image.getBuffer("image/png"));
}

/** Teams outline icon: 32x32, transparent bg, light silhouette. */
async function makeOutlinePng(path: string, size: number): Promise<Buffer> {
  const image = await Jimp.read(path);
  image.resize({ w: size, h: size });
  const { data, width, height } = image.bitmap;

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = (width * y + x) * 4;
      const r = data[idx]!;
      const g = data[idx + 1]!;
      const b = data[idx + 2]!;
      const a = data[idx + 3]!;
      const nearWhite = r > 240 && g > 240 && b > 240;
      if (nearWhite || a < 16) {
        data[idx] = 0;
        data[idx + 1] = 0;
        data[idx + 2] = 0;
        data[idx + 3] = 0;
      } else {
        data[idx] = 255;
        data[idx + 1] = 255;
        data[idx + 2] = 255;
        data[idx + 3] = 255;
      }
    }
  }

  return Buffer.from(await image.getBuffer("image/png"));
}

function loadManifestTemplate(templatesDir: string): string {
  const path = join(templatesDir, "manifest.json");
  if (existsSync(path)) return readFileSync(path, "utf8");
  const fallback = join(
    dirname(fileURLToPath(import.meta.url)),
    "teams",
    "manifest.json",
  );
  if (existsSync(fallback)) return readFileSync(fallback, "utf8");
  throw new Error("Teams manifest template not found");
}

function minimalPng(): Buffer {
  return Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
    "base64",
  );
}
