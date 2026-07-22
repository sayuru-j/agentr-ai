/** Derive https://host from wss://host/ws for artifact uploads. */
export function httpBaseFromRelayUrl(relayUrl: string): string {
  try {
    const u = new URL(relayUrl);
    u.protocol = u.protocol === "wss:" ? "https:" : u.protocol === "ws:" ? "http:" : u.protocol;
    u.pathname = "";
    u.search = "";
    u.hash = "";
    return u.toString().replace(/\/$/, "");
  } catch {
    return relayUrl
      .replace(/^wss:/i, "https:")
      .replace(/^ws:/i, "http:")
      .replace(/\/ws\/?$/i, "")
      .replace(/\/$/, "");
  }
}

export async function uploadScreenshotsHttps(opts: {
  relayUrl: string;
  workerToken: string;
  taskId: string;
  screenshots: Array<{
    name: string;
    mimeType: string;
    label: string;
    buffer: Buffer;
  }>;
  tlsInsecure?: boolean;
}): Promise<{ ok: boolean; error?: string }> {
  const base = httpBaseFromRelayUrl(opts.relayUrl);
  const url = `${base}/api/artifacts`;
  const body = {
    taskId: opts.taskId,
    screenshots: opts.screenshots.map((s) => ({
      name: s.name,
      mimeType: s.mimeType,
      label: s.label,
      dataBase64: s.buffer.toString("base64"),
    })),
  };

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${opts.workerToken}`,
      "X-AgentR-Token": opts.workerToken,
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    return { ok: false, error: `HTTP ${res.status} ${text.slice(0, 200)}` };
  }
  return { ok: true };
}
