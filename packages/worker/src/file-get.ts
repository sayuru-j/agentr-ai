import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
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
/** Cap how many path matches we list when disambiguating. */
const MAX_LIST = 8;
/** Stop walking after this many files scanned. */
const MAX_WALK_FILES = 20_000;
const MAX_DEPTH = 12;

const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  ".hg",
  ".svn",
  ".next",
  ".nuxt",
  "dist",
  "build",
  "out",
  "coverage",
  "__pycache__",
  ".venv",
  "venv",
  ".turbo",
  ".cache",
  "target",
]);

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
  const cleaned = normalizeQuery(relativePath);
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

function normalizeQuery(relativePath: string): string {
  return relativePath
    .replace(/\\/g, "/")
    .replace(/^\.\/+/, "")
    .replace(/^\/+/, "")
    .replace(/^(\*\*\/)+/, "") // allow **/index.html
    .trim();
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

/** Walk project for files whose path matches a basename or suffix query. */
export function findProjectFileMatches(
  projectRoot: string,
  query: string,
): string[] {
  const cleaned = normalizeQuery(query).toLowerCase();
  if (!cleaned) return [];
  const wantName = basename(cleaned);
  const root = resolve(projectRoot);
  const matches: string[] = [];
  let scanned = 0;

  const walk = (dir: string, depth: number): void => {
    if (depth > MAX_DEPTH || scanned >= MAX_WALK_FILES) return;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of entries) {
      if (scanned >= MAX_WALK_FILES) return;
      const name = ent.name;
      if (name === "." || name === "..") continue;
      const abs = resolve(dir, name);
      if (ent.isDirectory()) {
        if (SKIP_DIRS.has(name)) continue;
        walk(abs, depth + 1);
        continue;
      }
      if (!ent.isFile()) continue;
      scanned += 1;
      const rel = relative(root, abs).split(sep).join("/");
      const relLower = rel.toLowerCase();
      if (
        relLower === cleaned ||
        relLower.endsWith(`/${cleaned}`) ||
        basename(relLower) === wantName
      ) {
        matches.push(rel);
      }
    }
  };

  walk(root, 0);
  // Prefer shorter paths (closer to root), then alpha
  matches.sort((a, b) => a.length - b.length || a.localeCompare(b));
  return matches;
}

/**
 * Resolve a user path query: exact hit, else unique basename/suffix match.
 */
export function resolveProjectFileQuery(
  projectRoot: string,
  relativePath: string,
): { ok: true; abs: string; relative: string } | { ok: false; error: string } {
  const exact = resolveSafeProjectPath(projectRoot, relativePath);
  if (exact.ok && existsSync(exact.abs)) {
    try {
      if (statSync(exact.abs).isFile()) return exact;
    } catch {
      /* fall through to search */
    }
  }

  const matches = findProjectFileMatches(projectRoot, relativePath);
  if (matches.length === 0) {
    const hint = exact.ok ? exact.relative : normalizeQuery(relativePath);
    return {
      ok: false,
      error: `Not found: \`${hint}\`. Try a fuller path (e.g. \`sample_app/index.html\`).`,
    };
  }
  if (matches.length === 1) {
    return resolveSafeProjectPath(projectRoot, matches[0]!);
  }

  // Prefer a single "best" match when query is a path suffix with unique end
  const cleaned = normalizeQuery(relativePath).toLowerCase();
  const suffixHits = matches.filter(
    (m) =>
      m.toLowerCase() === cleaned || m.toLowerCase().endsWith(`/${cleaned}`),
  );
  if (suffixHits.length === 1) {
    return resolveSafeProjectPath(projectRoot, suffixHits[0]!);
  }

  const shown = matches.slice(0, MAX_LIST);
  const more =
    matches.length > MAX_LIST ? `\n…and ${matches.length - MAX_LIST} more` : "";
  const list = shown.map((m) => `• \`${m}\``).join("\n");
  return {
    ok: false,
    error: `Multiple matches for \`${normalizeQuery(relativePath)}\` — pick one:\n${list}${more}`,
  };
}

function readResolvedFile(
  abs: string,
  relativePath: string,
): FileGetPayload {
  let st;
  try {
    st = statSync(abs);
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

  const name = basename(abs);
  const ext = extname(name).toLowerCase();
  if (DENIED_EXT.has(ext)) {
    return {
      ok: false,
      error: `Extension \`${ext}\` is blocked for /get`,
    };
  }

  let buffer: Buffer;
  try {
    buffer = readFileSync(abs);
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
      relativePath,
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
    relativePath,
    mimeType,
    sizeBytes,
    delivery: "download",
    dataBase64: buffer.toString("base64"),
  };
}

/**
 * Read a project file for Teams `!alias /get`.
 * Resolves exact paths, or searches by basename / path suffix when needed.
 */
export function readProjectFileForGet(
  projectRoot: string,
  relativePath: string,
): FileGetPayload {
  const resolved = resolveProjectFileQuery(projectRoot, relativePath);
  if (!resolved.ok) return resolved;
  return readResolvedFile(resolved.abs, resolved.relative);
}

function formatSize(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}
