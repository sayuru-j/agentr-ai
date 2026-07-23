import { createHash, randomBytes } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  readdirSync,
  statSync,
  rmSync,
} from "node:fs";
import { extname, join } from "node:path";
import { tmpdir } from "node:os";

export interface StoredArtifact {
  taskId: string;
  name: string;
  mimeType: string;
  label: string;
  /** Absolute HTTPS (or http) URL Teams can fetch */
  url: string;
  path: string;
}

export class ArtifactStore {
  private readonly root: string;
  private readonly mimeByKey = new Map<string, string>();

  constructor(
    private readonly publicBaseUrl: string,
    root?: string,
  ) {
    this.root = root ?? join(tmpdir(), "agent-relay-artifacts");
    mkdirSync(this.root, { recursive: true });
  }

  save(opts: {
    taskId: string;
    name: string;
    mimeType: string;
    dataBase64: string;
    label?: string;
  }): StoredArtifact {
    const safeTask = sanitize(opts.taskId);
    const safeName =
      sanitizeFilename(opts.name) ||
      `file-${randomBytes(4).toString("hex")}.bin`;
    const dir = join(this.root, safeTask);
    mkdirSync(dir, { recursive: true });
    const path = join(dir, safeName);
    const buf = Buffer.from(opts.dataBase64, "base64");
    writeFileSync(path, buf);

    const mimeType = opts.mimeType || mimeFromName(safeName);
    this.mimeByKey.set(`${safeTask}/${safeName}`, mimeType);
    writeFileSync(
      `${path}.meta.json`,
      JSON.stringify({ mimeType }, null, 0),
      "utf8",
    );

    const token = createHash("sha256")
      .update(`${safeTask}:${safeName}:${buf.length}`)
      .digest("hex")
      .slice(0, 16);

    const url = `${this.publicBaseUrl.replace(/\/$/, "")}/api/artifacts/${safeTask}/${encodeURIComponent(safeName)}?t=${token}`;

    return {
      taskId: opts.taskId,
      name: safeName,
      mimeType,
      label: opts.label || safeName,
      url,
      path,
    };
  }

  saveBuffer(opts: {
    taskId: string;
    name: string;
    mimeType: string;
    buffer: Buffer;
    label?: string;
  }): StoredArtifact {
    return this.save({
      ...opts,
      dataBase64: opts.buffer.toString("base64"),
    });
  }

  read(
    taskId: string,
    name: string,
  ): { buffer: Buffer; mimeType: string; downloadName: string } | null {
    const safeTask = sanitize(taskId);
    const safeName = sanitizeFilename(name);
    const path = join(this.root, safeTask, safeName);
    if (!existsSync(path)) return null;
    const buffer = readFileSync(path);
    const key = `${safeTask}/${safeName}`;
    let mimeType = this.mimeByKey.get(key);
    if (!mimeType) {
      try {
        const meta = JSON.parse(readFileSync(`${path}.meta.json`, "utf8")) as {
          mimeType?: string;
        };
        mimeType = meta.mimeType;
      } catch {
        /* fall through */
      }
    }
    mimeType = mimeType || mimeFromName(safeName);
    this.mimeByKey.set(key, mimeType);
    return { buffer, mimeType, downloadName: safeName };
  }

  /** Drop artifact dirs older than maxAgeMs (default 24h). */
  cleanup(maxAgeMs = 24 * 60 * 60 * 1000): void {
    if (!existsSync(this.root)) return;
    const now = Date.now();
    for (const entry of readdirSync(this.root)) {
      const dir = join(this.root, entry);
      try {
        const st = statSync(dir);
        if (st.isDirectory() && now - st.mtimeMs > maxAgeMs) {
          rmSync(dir, { recursive: true, force: true });
        }
      } catch {
        /* ignore */
      }
    }
  }
}

function sanitize(id: string): string {
  return id.replace(/[^a-zA-Z0-9._-]/g, "").slice(0, 80) || "task";
}

function sanitizeFilename(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 120);
}

function mimeFromName(name: string): string {
  const ext = extname(name).toLowerCase();
  const map: Record<string, string> = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".webp": "image/webp",
    ".svg": "image/svg+xml",
    ".pdf": "application/pdf",
    ".json": "application/json",
    ".md": "text/markdown",
    ".txt": "text/plain",
    ".zip": "application/zip",
  };
  return map[ext] || "application/octet-stream";
}
