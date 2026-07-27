import type { ProjectGuardrails } from "./protocol.js";

/** Patterns that should pause for phone approval before continuing. */
export const RISK_PATTERNS: ReadonlyArray<{ pattern: RegExp; reason: string }> =
  [
    {
      pattern: /\brm\s+(-[a-zA-Z]*f[a-zA-Z]*\s+)?-?[rR]\b/,
      reason: "Destructive recursive delete",
    },
    {
      pattern: /\bgit\s+reset\s+--hard\b/i,
      reason: "Hard reset discards local changes",
    },
    {
      pattern: /\bgit\s+push\s+.*--force\b/i,
      reason: "Force push rewrites remote history",
    },
    {
      pattern: /\bnpm\s+(install|ci|uninstall)\b/i,
      reason: "Package install/uninstall modifies node_modules",
    },
    {
      pattern: /\bpnpm\s+(install|add|remove|i)\b/i,
      reason: "Package install/uninstall modifies dependencies",
    },
    {
      pattern: /\byarn\s+(install|add|remove)\b/i,
      reason: "Package install/uninstall modifies dependencies",
    },
    {
      pattern: /\bsudo\b/i,
      reason: "Elevated privileges requested",
    },
    {
      pattern: /\b(drop|truncate)\s+table\b/i,
      reason: "Destructive database operation",
    },
    {
      pattern: /\bformat\s+[a-z]:\b/i,
      reason: "Disk format command",
    },
    {
      pattern: /\bdel\s+\/[sS]\b/,
      reason: "Recursive delete on Windows",
    },
    {
      pattern: /\brmdir\s+\/[sS]\b/i,
      reason: "Recursive directory remove on Windows",
    },
  ];

export type RiskTier = "block" | "approve" | "allow";

export function matchRiskCommand(
  line: string,
): { command: string; reason: string; tier: RiskTier } | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  for (const { pattern, reason } of RISK_PATTERNS) {
    if (pattern.test(trimmed)) {
      return { command: trimmed, reason, tier: "approve" };
    }
  }
  return null;
}

function compilePattern(raw: string): RegExp | null {
  try {
    return new RegExp(raw, "i");
  } catch {
    return null;
  }
}

/** Combine global risk patterns with per-project deny/allow lists. */
export function matchRiskWithGuardrails(
  line: string,
  guardrails?: ProjectGuardrails,
): { command: string; reason: string; tier: RiskTier } | null {
  const trimmed = line.trim();
  if (!trimmed) return null;

  if (guardrails?.allowPatterns?.length) {
    for (const raw of guardrails.allowPatterns) {
      const p = compilePattern(raw);
      if (p?.test(trimmed)) return null;
    }
  }

  if (guardrails?.denyPatterns?.length) {
    for (const raw of guardrails.denyPatterns) {
      const p = compilePattern(raw);
      if (p?.test(trimmed)) {
        return { command: trimmed, reason: "Blocked by project deny rule", tier: "block" };
      }
    }
  }

  const base = matchRiskCommand(trimmed);
  if (base) return base;

  if (guardrails?.requireApproval) {
    return {
      command: trimmed,
      reason: "Project requires approval for all shell commands",
      tier: "approve",
    };
  }

  return null;
}

/** Parse `!alias prompt` from a Teams message (prompt may be empty for file-only). */
export function parseProjectAlias(text: string): {
  alias?: string;
  prompt: string;
} {
  const bang = text.match(/^\s*!([A-Za-z0-9_-]+)(?:\s+([\s\S]*))?$/);
  if (bang) return { alias: bang[1]!.trim(), prompt: (bang[2] ?? "").trim() };
  return { prompt: text.trim() };
}

export const PROTOCOL_VERSION = "0.3.0";
export const WS_PATH = "/ws";
