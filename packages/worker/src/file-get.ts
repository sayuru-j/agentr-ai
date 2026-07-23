import { existsSync, readFileSync, statSync } from "node:fs";
import {
  basename,
  extname,
  isAbsolute,
  relative,
  resolve,
  sep,
} from "node:path";

/** Hard cap for files returned to Teams (download or inline). */
export const FILE_GET_MAX_BYTES = 1_500_000;
/** Max characters pasted into a Teams message (rest truncated). */
export const FILE_GET_INLINE_CHARS = 12_000;

/** Blocked for /get (executables / script droppers). */
const DENIED_EXT = new Set([
  ".exe",
  ".dll",
  ".bat",
  ".cmd",
  ".msi",
  ".scr",
  ".com",
  ".cpl",
  ".sys",
  ".vbs",
  ".jse",
  ".wsf",
  ".wsh",
]);

/** Extensions we prefer as plain-text inline when small enough. */
const TEXT_EXT = new Set([
  ".md",
  ".txt",
  ".json",
  ".jsonc",
  ".yaml",
  ".yml",
  ".toml",
  ".xml",
  ".html",
  ".htm",
  ".css",
  ".scss",
  ".less",
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".py",
  ".rb",
  ".go",
  ".rs",
  ".java",
  ".kt",
  ".cs",
  ".php",
  ".sh",
  ".bash",
  ".zsh",
  ".ps1",
  ".sql",
  ".graphql",
  ".env",
  ".ini",
  ".cfg",
  ".conf",
  ".gitignore",
  ".dockerignore",
  ".editorconfig",
  ".csv",
  ".tsv",
  ".log",
  ".svg",
]);

const MIME_BY_EXT: Record<string, string> = {
  ".md": "text/markdown",
  ".txt": "text/plain",
  ".json": "application/json",
  ".jsonc": "application/json",
  ".yaml": "text/yaml",
  ".yml": "text/yaml",
  ".xml": "application/xml",
  ".html": "text/html",
  ".htm": "text/html",
  ".css": "text/css",
  ".ts": "text/typescript",
  ".tsx": "text/typescript",
  ".js": "text/javascript",
  ".jsx": "text/javascript",
  ".mjs": "text/javascript",
  ".cjs": "text/javascript",
  ".py": "text/x-python",
  ".ps1": "text/plain",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".pdf": "application/pdf",
  ".zip": "application/zip",
};

export type FileGetPayload =
  | {
      ok: true;
      name: string;
      relativePath: string;
      mimeType: string;
      sizeBytes: number;
      delivery: "inline";
      text: string;
      truncated: boolean;
    }
  | {
      ok: true;
      name: string;
      relativePath: string;
      mimeType: string;
      sizeBytes: number;
      delivery: "download";
      dataBase64: string;
    }
  | { ok: false; error: string };

/**
 * Resolve `relativePath` under `projectRoot` without leaving the project tree.
 */
export function resolveSafeProjectPath(
  projectRoot: string,
  relativePath: string,
): { ok: true; abs: string; relative: string } | { ok: false; error: string } {
  const cleaned = relativePath
    .replace(/\\/g, "/")
    .replace(/^\/+/, "")
    .trim();
  if (!cleaned || cleaned.includes("\0")) {
    return { ok: false, error: "Invalid path" };
  }
  if (isAbsolute(cleaned) || /^[a-zA-Z]:/.test(cleaned)) {
    return { ok: false, error: "Path must be relative to the project root" };
  }

  const root = resolve(projectRoot);
  const abs = resolve(root, cleaned);
  const rel = relative(root, abs);
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) {
    return { ok: false, error: "Path must stay inside the project folder" };
  }
  const display = rel.split(sep).join("/");
  return { ok: true, abs, relative: display };
}

function mimeFor(name: string): string {
  const ext = extname(name).toLowerCase();
  return MIME_BY_EXT[ext] || "application/octet-stream";
}

function looksLikeText(buffer: Buffer, name: string): boolean {
  const ext = extname(name).toLowerCase();
  const mime = mimeFor(name);
  if (
    TEXT_EXT.has(ext) ||
    mime.startsWith("text/") ||
    mime.includes("json") ||
    mime.includes("xml") ||
    mime === "image/svg+xml"
  ) {
    const sample = buffer.subarray(0, Math.min(buffer.length, 8192));
    return !sample.includes(0);
  }
  const sample = buffer.subarray(0, Math.min(buffer.length, 8192));
  if (sample.includes(0)) return false;
  let bad = 0;
  for (const b of sample) {
    if (b === 9 || b === 10 || b === 13) continue;
    if (b < 32 || b > 126) bad += 1;
  }
  return bad / Math.max(sample.length, 1) < 0.05;
}

/** Read a project-relative file for Teams `!alias /get`. */
export function readProjectFileForGet(
  projectRoot: string,
  relativePath: string,
): FileGetPayload {
  const resolved = resolveSafeProjectPath(projectRoot, relativePath);
  if (!resolved.ok) return resolved;

  if (!existsSync(resolved.abs)) {
    return { ok: false, error: `Not found: \`${resolved.relative}\`` };
  }

  let st;
  try {
    st = statSync(resolved.abs);
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
  if (!st.isFile()) {
    return { ok: false, error: "Path is not a file" };
  }
  if (st.size > FILE_GET_MAX_BYTES) {
    const mb = (FILE_GET_MAX_BYTES / (1024 * 1024)).toFixed(1);
    return {
      ok: false,
      error: `File too large (${formatSize(st.size)}; max ${mb} MB)`,
    };
  }

  const name = basename(resolved.abs);
  const ext = extname(name).toLowerCase();
  if (DENIED_EXT.has(ext)) {
    return {
      ok: false,
      error: `Extension \`${ext}\` is blocked for /get`,
    };
  }

  let buffer: Buffer;
  try {
    buffer = readFileSync(resolved.abs);
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }

  const mimeType = mimeFor(name);
  const sizeBytes = buffer.length;

  if (looksLikeText(buffer, name) && sizeBytes <= FILE_GET_INLINE_CHARS * 4) {
    let text = buffer.toString("utf8");
    let truncated = false;
    if (text.length > FILE_GET_INLINE_CHARS) {
      text = text.slice(0, FILE_GET_INLINE_CHARS);
      truncated = true;
    }
    return {
      ok: true,
      name,
      relativePath: resolved.relative,
      mimeType:
        mimeType.startsWith("text/") ||
        mimeType.includes("json") ||
        mimeType.includes("xml") ||
        mimeType === "image/svg+xml"
          ? mimeType
          : "text/plain",
      sizeBytes,
      delivery: "inline",
      text,
      truncated,
    };
  }

  return {
    ok: true,
    name,
    relativePath: resolved.relative,
    mimeType,
    sizeBytes,
    delivery: "download",
    dataBase64: buffer.toString("base64"),
  };
}

function formatSize(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}
