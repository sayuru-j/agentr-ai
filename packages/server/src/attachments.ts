import { MicrosoftAppCredentials } from "botframework-connector";
import type { Attachment } from "botbuilder";

const MAX_FILES = 8;
const MAX_BYTES = 5 * 1024 * 1024; // 5 MiB each

export interface DownloadedFile {
  name: string;
  mimeType: string;
  dataBase64: string;
}

function isSkippableAttachment(att: Attachment): boolean {
  const ct = (att.contentType ?? "").toLowerCase();
  // Adaptive Card / hero card payloads — not user files
  if (ct.includes("adaptivecard") || ct.includes("card")) return true;
  if (ct === "text/html") return true;
  return false;
}

function safeName(name: string | undefined, index: number): string {
  const base = (name || `file-${index + 1}`).replace(/[/\\?%*:|"<>]/g, "_").trim();
  return base.slice(0, 180) || `file-${index + 1}`;
}

/**
 * Download user file attachments from a Teams/Bot Framework activity.
 * Uses Microsoft App credentials when the content URL requires auth.
 */
export async function downloadActivityFiles(opts: {
  attachments: Attachment[] | undefined;
  appId: string;
  appPassword: string;
  tenantId?: string;
}): Promise<{ files: DownloadedFile[]; errors: string[] }> {
  const attachments = (opts.attachments ?? []).filter(
    (a) => a?.contentUrl && !isSkippableAttachment(a),
  );
  if (attachments.length === 0) {
    return { files: [], errors: [] };
  }

  const errors: string[] = [];
  const files: DownloadedFile[] = [];
  const slice = attachments.slice(0, MAX_FILES);
  if (attachments.length > MAX_FILES) {
    errors.push(`Only the first ${MAX_FILES} attachments were kept.`);
  }

  let token: string | null = null;
  const ensureToken = async (): Promise<string | null> => {
    if (token) return token;
    if (!opts.appId || !opts.appPassword) return null;
    try {
      if (opts.tenantId) {
        MicrosoftAppCredentials.trustServiceUrl("https://smba.trafficmanager.net");
      }
      const creds = new MicrosoftAppCredentials(
        opts.appId,
        opts.appPassword,
        opts.tenantId || undefined,
      );
      token = await creds.getToken();
      return token;
    } catch (err) {
      errors.push(
        `Could not get download token: ${err instanceof Error ? err.message : String(err)}`,
      );
      return null;
    }
  };

  for (let i = 0; i < slice.length; i++) {
    const att = slice[i]!;
    const url = att.contentUrl!;
    const name = safeName(att.name, i);
    try {
      let res = await fetch(url);
      if (res.status === 401 || res.status === 403) {
        const t = await ensureToken();
        if (t) {
          res = await fetch(url, {
            headers: { Authorization: `Bearer ${t}` },
          });
        }
      }
      if (!res.ok) {
        errors.push(`${name}: HTTP ${res.status}`);
        continue;
      }
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length > MAX_BYTES) {
        errors.push(`${name}: exceeds ${MAX_BYTES / (1024 * 1024)} MiB limit`);
        continue;
      }
      if (buf.length === 0) {
        errors.push(`${name}: empty file`);
        continue;
      }
      files.push({
        name,
        mimeType: att.contentType || "application/octet-stream",
        dataBase64: buf.toString("base64"),
      });
    } catch (err) {
      errors.push(
        `${name}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  return { files, errors };
}
