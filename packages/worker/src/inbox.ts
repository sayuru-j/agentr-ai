import { mkdirSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import type { TaskFile } from "@agentr/shared";

export function writeTaskInboxFiles(
  cwd: string,
  files: TaskFile[],
): { dir: string; paths: string[] } {
  const dir = join(cwd, ".agentr-inbox");
  mkdirSync(dir, { recursive: true });
  const paths: string[] = [];
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");

  for (const file of files) {
    const safe =
      basename(file.name).replace(/[^\w.\- ()[\]]+/g, "_").slice(0, 160) ||
      "file.bin";
    const dest = join(dir, `${stamp}-${safe}`);
    writeFileSync(dest, Buffer.from(file.dataBase64, "base64"));
    paths.push(dest);
  }

  return { dir, paths };
}
