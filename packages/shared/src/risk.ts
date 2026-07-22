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

export function matchRiskCommand(
  line: string,
): { command: string; reason: string } | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  for (const { pattern, reason } of RISK_PATTERNS) {
    if (pattern.test(trimmed)) {
      return { command: trimmed, reason };
    }
  }
  return null;
}

/** Parse `!alias prompt` from a Teams message. */
export function parseProjectAlias(text: string): {
  alias?: string;
  prompt: string;
} {
  const bang = text.match(/^\s*!([A-Za-z0-9_-]+)\s+([\s\S]*)$/);
  if (bang) return { alias: bang[1]!.trim(), prompt: bang[2]!.trim() };
  return { prompt: text.trim() };
}

export const PROTOCOL_VERSION = "0.1.0";
export const WS_PATH = "/ws";
