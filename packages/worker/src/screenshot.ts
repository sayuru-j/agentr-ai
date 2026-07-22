import { Jimp } from "jimp";
import screenshot from "screenshot-desktop";

export type ScreenshotQuality = "preview" | "hq";

export interface CapturedScreen {
  name: string;
  label: string;
  mimeType: "image/jpeg";
  buffer: Buffer;
}

const PREVIEW_MAX_WIDTH = 1600;
const PREVIEW_JPEG_QUALITY = 72;
const HQ_JPEG_QUALITY = 98;

/**
 * Capture every display.
 * - preview: downscaled JPEG for fast Teams previews
 * - hq: native resolution, high-quality JPEG (no downscale)
 */
export async function captureAllDisplays(
  quality: ScreenshotQuality = "preview",
): Promise<CapturedScreen[]> {
  let pngs: Buffer[];
  try {
    const all = await screenshot.all();
    pngs = Array.isArray(all) ? all : [all];
  } catch {
    pngs = [await screenshot({ format: "png" })];
  }

  if (pngs.length === 0) {
    pngs = [await screenshot({ format: "png" })];
  }

  const out: CapturedScreen[] = [];
  for (let i = 0; i < pngs.length; i++) {
    const png = pngs[i]!;
    const jpeg =
      quality === "hq" ? await toHqJpeg(png) : await toPreviewJpeg(png);
    const n = i + 1;
    out.push({
      name: `screen-${n}.jpg`,
      label: pngs.length > 1 ? `Display ${n}` : "Desktop",
      mimeType: "image/jpeg",
      buffer: jpeg,
    });
  }
  return out;
}

async function toPreviewJpeg(png: Buffer): Promise<Buffer> {
  const image = await Jimp.read(png);
  if (image.width > PREVIEW_MAX_WIDTH) {
    image.resize({ w: PREVIEW_MAX_WIDTH });
  }
  return Buffer.from(
    await image.getBuffer("image/jpeg", { quality: PREVIEW_JPEG_QUALITY }),
  );
}

async function toHqJpeg(png: Buffer): Promise<Buffer> {
  const image = await Jimp.read(png);
  return Buffer.from(
    await image.getBuffer("image/jpeg", { quality: HQ_JPEG_QUALITY }),
  );
}
