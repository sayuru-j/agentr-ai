import { execFileSync } from "node:child_process";
import type { CliDiagnosisSummary } from "@agentr/shared";
import {
  type AgentBackend,
  parseAgentBackend,
} from "./config.js";
import { detectCodexCliProfile } from "./codex-cli.js";
import {
  commandMatchesBackend,
  resolveAgentCommand,
  stripConfiguredCommand,
} from "./resolve-agent.js";

export interface AgentDiagnosis extends CliDiagnosisSummary {
  command: string;
  backend: AgentBackend;
  profile?: Record<string, unknown>;
}

function runVersion(cmd: string, backend: AgentBackend): string {
  const stripped = stripConfiguredCommand(cmd);
  const isAbsolute = /[\\/]/.test(stripped) || /^[a-zA-Z]:/.test(stripped);
  const args =
    backend === "codex"
      ? ["--version"]
      : ["--version"];
  try {
    return execFileSync(stripped, args, {
      encoding: "utf8",
      timeout: 8000,
      windowsHide: true,
      shell: process.platform === "win32" && !isAbsolute,
    }).trim();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("ENOENT")) return "";
    try {
      return execFileSync(stripped, ["--help"], {
        encoding: "utf8",
        timeout: 8000,
        windowsHide: true,
        shell: process.platform === "win32" && !isAbsolute,
      })
        .split(/\r?\n/)[0]
        ?.trim() ?? "";
    } catch {
      return "";
    }
  }
}

function readHelp(cmd: string, backend: AgentBackend): string {
  const stripped = stripConfiguredCommand(cmd);
  const isAbsolute = /[\\/]/.test(stripped) || /^[a-zA-Z]:/.test(stripped);
  const args = backend === "codex" ? ["exec", "--help"] : ["--help"];
  try {
    return execFileSync(stripped, args, {
      encoding: "utf8",
      timeout: 8000,
      windowsHide: true,
      shell: process.platform === "win32" && !isAbsolute,
    });
  } catch {
    return "";
  }
}

export function detectResumeSupport(
  help: string,
  backend: AgentBackend,
): { resumeFlag?: string; threadFlag?: string } {
  if (backend === "codex") {
    if (/--resume\b/.test(help)) return { resumeFlag: "--resume" };
    if (/--thread\b/.test(help)) return { threadFlag: "--thread" };
    if (/-t,\s*--thread/.test(help)) return { threadFlag: "-t" };
  }
  if (backend === "cursor") {
    if (/--resume\b/.test(help)) return { resumeFlag: "--resume" };
    if (/--continue\b/.test(help)) return { resumeFlag: "--continue" };
  }
  return {};
}

/** Unified agent CLI diagnosis for tray checklist and worker.hello. */
export function diagnoseAgentCli(
  configured: string,
  backend: AgentBackend | string = "cursor",
): AgentDiagnosis {
  const resolvedBackend = parseAgentBackend(backend);
  const resolved = resolveAgentCommand(configured, resolvedBackend);
  const errors: string[] = [];
  const warnings: string[] = [];

  if (!resolved.found) {
    errors.push(`${resolvedBackend} CLI not found (${resolved.source})`);
    return {
      ok: false,
      command: resolved.command,
      backend: resolvedBackend,
      errors,
      warnings,
    };
  }

  if (!commandMatchesBackend(resolvedBackend, resolved.command)) {
    errors.push(
      `Configured path looks like the wrong backend for ${resolvedBackend}`,
    );
  }

  const version = runVersion(resolved.command, resolvedBackend);
  if (!version) {
    warnings.push("Could not read CLI version");
  }

  const help = readHelp(resolved.command, resolvedBackend);
  if (!help.trim()) {
    errors.push("CLI --help returned empty (binary may not run)");
  }

  const resume = detectResumeSupport(help, resolvedBackend);
  const profile: Record<string, unknown> = { ...resume };

  if (resolvedBackend === "codex") {
    const codexProfile = detectCodexCliProfile(resolved.command);
    Object.assign(profile, codexProfile);
    if (!codexProfile.jsonOutput) {
      warnings.push("Codex CLI may not support --json output");
    }
  }

  return {
    ok: errors.length === 0,
    command: resolved.command,
    backend: resolvedBackend,
    version: version || undefined,
    errors: errors.length ? errors : undefined,
    warnings: warnings.length ? warnings : undefined,
    profile,
  };
}

export function toCliDiagnosisSummary(d: AgentDiagnosis): CliDiagnosisSummary {
  return {
    ok: d.ok,
    version: d.version,
    errors: d.errors,
    warnings: d.warnings,
  };
}
