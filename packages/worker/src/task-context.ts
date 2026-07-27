import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_CONFIG_DIR } from "./config.js";

export interface TaskContextEntry {
  taskId: string;
  conversationId: string;
  projectAlias?: string;
  agentThreadId?: string;
  prompt: string;
  logSummary: string;
  exitCode?: number;
  finishedAt: number;
}

interface TaskContextStore {
  entries: TaskContextEntry[];
}

const CONTEXT_PATH = join(DEFAULT_CONFIG_DIR, "task-context.json");
const MAX_ENTRIES = 200;

function loadStore(): TaskContextStore {
  if (!existsSync(CONTEXT_PATH)) return { entries: [] };
  try {
    const raw = JSON.parse(readFileSync(CONTEXT_PATH, "utf8")) as TaskContextStore;
    return { entries: Array.isArray(raw.entries) ? raw.entries : [] };
  } catch {
    return { entries: [] };
  }
}

function saveStore(store: TaskContextStore): void {
  mkdirSync(DEFAULT_CONFIG_DIR, { recursive: true });
  writeFileSync(CONTEXT_PATH, JSON.stringify(store, null, 2) + "\n", "utf8");
}

export function saveTaskContext(entry: TaskContextEntry): void {
  const store = loadStore();
  store.entries = store.entries.filter(
    (e) =>
      !(
        e.conversationId === entry.conversationId &&
        e.projectAlias === entry.projectAlias
      ),
  );
  store.entries.unshift(entry);
  if (store.entries.length > MAX_ENTRIES) {
    store.entries = store.entries.slice(0, MAX_ENTRIES);
  }
  saveStore(store);
}

export function getTaskContext(
  conversationId: string,
  projectAlias?: string,
): TaskContextEntry | undefined {
  const store = loadStore();
  if (projectAlias) {
    return store.entries.find(
      (e) =>
        e.conversationId === conversationId && e.projectAlias === projectAlias,
    );
  }
  return store.entries.find((e) => e.conversationId === conversationId);
}

export function summarizeLogs(logs: string[], maxLen = 2000): string {
  const text = logs.join("").trim();
  if (text.length <= maxLen) return text;
  return "…\n" + text.slice(-maxLen);
}

/** Build prompt for context-injection resume fallback. */
export function buildResumePrompt(
  parent: {
    priorPrompt?: string;
    logSummary?: string;
  },
  userPrompt: string,
): string {
  const parts: string[] = [
    "## Continue from previous task",
    parent.priorPrompt ? `Previous prompt: ${parent.priorPrompt}` : "",
    parent.logSummary
      ? `Previous output (tail):\n\`\`\`\n${parent.logSummary}\n\`\`\``
      : "",
    "## New instruction",
    userPrompt.trim() || "Continue where you left off.",
  ];
  return parts.filter(Boolean).join("\n\n");
}
