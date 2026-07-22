import { Jimp } from "jimp";
import screenshot from "screenshot-desktop";

export interface CapturedScreen {
  name: string;
  label: string;
  mimeType: "image/jpeg";
  buffer: Buffer;
}

const MAX_WIDTH = 1600;
const JPEG_QUALITY = 72;

/**
 * Capture every display as a compressed JPEG suitable for Teams.
 * Falls back to primary display if `all()` is unavailable.
 */
export async function captureAllDisplays(): Promise<CapturedScreen[]> {
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
    const jpeg = await compressPngToJpeg(png);
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

async function compressPngToJpeg(png: Buffer): Promise<Buffer> {
  const image = await Jimp.read(png);
  if (image.width > MAX_WIDTH) {
    image.resize({ w: MAX_WIDTH });
  }
  return Buffer.from(await image.getBuffer("image/jpeg", { quality: JPEG_QUALITY }));
}
