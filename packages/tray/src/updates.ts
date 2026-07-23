/**
 * Compare semver-ish versions (major.minor.patch). Returns true if remote > local.
 */
export function isNewerVersion(remote: string, local: string): boolean {
  const parse = (v: string) =>
    v
      .replace(/^v/i, "")
      .split(/[.+-]/)
      .slice(0, 3)
      .map((p) => Number.parseInt(p, 10) || 0);
  const a = parse(remote);
  const b = parse(local);
  for (let i = 0; i < 3; i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    if (d !== 0) return d > 0;
  }
  return false;
}

export interface UpdateCheckResult {
  checked: boolean;
  updateAvailable: boolean;
  localVersion: string;
  remoteVersion?: string;
  releaseUrl?: string;
  portableUrl?: string;
  error?: string;
}

const DEFAULT_REPO = "sayuru-j/agentr-ai";

export async function checkGithubReleaseUpdate(opts: {
  localVersion: string;
  repo?: string;
  signal?: AbortSignal;
}): Promise<UpdateCheckResult> {
  const repo = opts.repo || process.env.AGENTR_GITHUB_REPO || DEFAULT_REPO;
  const localVersion = opts.localVersion.replace(/^v/i, "");
  try {
    const res = await fetch(
      `https://api.github.com/repos/${repo}/releases/latest`,
      {
        headers: {
          Accept: "application/vnd.github+json",
          "User-Agent": "AgentR-tray",
        },
        signal: opts.signal,
      },
    );
    if (res.status === 404) {
      return {
        checked: true,
        updateAvailable: false,
        localVersion,
        error: "No GitHub releases yet",
      };
    }
    if (!res.ok) {
      return {
        checked: true,
        updateAvailable: false,
        localVersion,
        error: `GitHub HTTP ${res.status}`,
      };
    }
    const body = (await res.json()) as {
      tag_name?: string;
      html_url?: string;
      assets?: Array<{ name?: string; browser_download_url?: string }>;
    };
    const remoteVersion = (body.tag_name || "").replace(/^v/i, "");
    if (!remoteVersion) {
      return {
        checked: true,
        updateAvailable: false,
        localVersion,
        error: "Release has no tag",
      };
    }
    const portable = (body.assets ?? []).find((a) =>
      /portable/i.test(a.name || ""),
    );
    const updateAvailable = isNewerVersion(remoteVersion, localVersion);
    return {
      checked: true,
      updateAvailable,
      localVersion,
      remoteVersion,
      releaseUrl: body.html_url,
      portableUrl: portable?.browser_download_url,
    };
  } catch (err) {
    return {
      checked: false,
      updateAvailable: false,
      localVersion,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
