import { existsSync, statfsSync } from "node:fs";
import type { ProjectDisk } from "@agentr/shared";
import { projectPath, type ProjectEntry } from "./config.js";

function formatError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Probe free/total disk space for each project folder. */
export function probeProjectDisks(
  projects: Record<string, ProjectEntry>,
): ProjectDisk[] {
  const out: ProjectDisk[] = [];
  for (const [alias, entry] of Object.entries(projects)) {
    const path = projectPath(entry);
    if (!path) continue;
    if (!existsSync(path)) {
      out.push({ alias, path, error: "path missing" });
      continue;
    }
    try {
      const s = statfsSync(path);
      const bsize = Number(s.bsize) || 0;
      const freeBytes = Number(s.bavail) * bsize;
      const totalBytes = Number(s.blocks) * bsize;
      out.push({
        alias,
        path,
        freeBytes: Number.isFinite(freeBytes) ? freeBytes : undefined,
        totalBytes: Number.isFinite(totalBytes) ? totalBytes : undefined,
      });
    } catch (err) {
      out.push({ alias, path, error: formatError(err) });
    }
  }
  return out;
}

export function formatBytes(n: number | undefined): string {
  if (n === undefined || !Number.isFinite(n)) return "?";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v < 10 && i > 0 ? v.toFixed(1) : Math.round(v)} ${units[i]}`;
}
