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
import { join } from "node:path";
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
    const safeName = sanitizeFilename(opts.name) || `shot-${randomBytes(4).toString("hex")}.jpg`;
    const dir = join(this.root, safeTask);
    mkdirSync(dir, { recursive: true });
    const path = join(dir, safeName);
    const buf = Buffer.from(opts.dataBase64, "base64");
    writeFileSync(path, buf);

    const token = createHash("sha256")
      .update(`${safeTask}:${safeName}:${buf.length}`)
      .digest("hex")
      .slice(0, 16);

    const url = `${this.publicBaseUrl.replace(/\/$/, "")}/api/artifacts/${safeTask}/${encodeURIComponent(safeName)}?t=${token}`;

    return {
      taskId: opts.taskId,
      name: safeName,
      mimeType: opts.mimeType || "image/jpeg",
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

  read(taskId: string, name: string): { buffer: Buffer; mimeType: string } | null {
    const path = join(this.root, sanitize(taskId), sanitizeFilename(name));
    if (!existsSync(path)) return null;
    const buffer = readFileSync(path);
    const mimeType = name.toLowerCase().endsWith(".png")
      ? "image/png"
      : "image/jpeg";
    return { buffer, mimeType };
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
