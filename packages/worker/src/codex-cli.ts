import { execFileSync } from "node:child_process";
import { stripConfiguredCommand } from "./resolve-agent.js";

export type CodexCliProfile = {
  jsonOutput: boolean;
  skipGitRepoCheck: boolean;
  configApprovalNever: boolean;
  modelShort: boolean;
  modelLong: boolean;
  modelConfig: boolean;
  cdShort: boolean;
  cdLong: boolean;
  sandbox?: string;
  resumeFlag?: string;
  threadFlag?: string;
};

const profileCache = new Map<string, CodexCliProfile>();

function readExecHelp(agentCommand: string): string {
  const cmd = stripConfiguredCommand(agentCommand) || "codex";
  try {
    const isAbsolute =
      /[\\/]/.test(cmd) || /^[a-zA-Z]:/.test(cmd);
    return execFileSync(cmd, ["exec", "--help"], {
      encoding: "utf8",
      timeout: 8000,
      windowsHide: true,
      shell: process.platform === "win32" && !isAbsolute,
    });
  } catch {
    return "";
  }
}

function execHelpHas(help: string, pattern: RegExp): boolean {
  return pattern.test(help);
}

export function detectCodexCliProfile(agentCommand: string): CodexCliProfile {
  const key = stripConfiguredCommand(agentCommand) || "codex";
  const cached = profileCache.get(key);
  if (cached) return cached;

  const help = readExecHelp(key);
  const profile: CodexCliProfile = {
    jsonOutput: execHelpHas(help, /--json\b/),
    skipGitRepoCheck: execHelpHas(help, /--skip-git-repo-check\b/),
    configApprovalNever: execHelpHas(help, /(?:--config\b|-c,)/),
    modelShort: execHelpHas(help, /-m,\s*--model\b/),
    modelLong: execHelpHas(help, /--model\s+<MODEL>/i),
    modelConfig: execHelpHas(help, /(?:--config\b|-c,)/),
    cdShort: execHelpHas(help, /-C,\s*--cd\b/),
    cdLong: execHelpHas(help, /--cd\s+<DIR>/i),
  };

  if (execHelpHas(help, /workspace-write/)) {
    profile.sandbox = "workspace-write";
  } else if (
    execHelpHas(help, /enabled,\s*disabled/i) ||
    execHelpHas(help, /\[possible values: enabled/)
  ) {
    profile.sandbox = "enabled";
  }

  if (execHelpHas(help, /--resume\b/)) {
    profile.resumeFlag = "--resume";
  } else if (execHelpHas(help, /-t,\s*--thread/)) {
    profile.threadFlag = "-t";
  } else if (execHelpHas(help, /--thread\b/)) {
    profile.threadFlag = "--thread";
  }

  if (!help.trim()) {
    profile.jsonOutput = false;
    profile.skipGitRepoCheck = false;
    profile.configApprovalNever = false;
    profile.modelShort = false;
    profile.modelLong = false;
    profile.modelConfig = true;
    profile.cdShort = false;
    profile.cdLong = false;
  }

  profileCache.set(key, profile);
  return profile;
}

export function buildCodexExecArgs(
  opts: { cwd: string; agentThreadId?: string },
  model: string,
  prompt: string,
  agentCommand: string,
): string[] {
  const profile = detectCodexCliProfile(agentCommand);
  const args = ["exec"];

  if (profile.jsonOutput) args.push("--json");
  if (profile.skipGitRepoCheck) args.push("--skip-git-repo-check");
  if (profile.sandbox) args.push("--sandbox", profile.sandbox);
  if (profile.configApprovalNever) {
    args.push("-c", "approval_policy=never");
  }

  if (opts.agentThreadId) {
    if (profile.resumeFlag) {
      args.push(profile.resumeFlag, opts.agentThreadId);
    } else if (profile.threadFlag) {
      args.push(profile.threadFlag, opts.agentThreadId);
    }
  }

  if (profile.modelShort) {
    args.push("-m", model);
  } else if (profile.modelLong) {
    args.push("--model", model);
  } else if (profile.modelConfig) {
    args.push("-c", `model="${model}"`);
  }

  if (profile.cdShort) {
    args.push("-C", opts.cwd);
  } else if (profile.cdLong) {
    args.push("--cd", opts.cwd);
  }

  args.push(prompt);
  return args;
}
