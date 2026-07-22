import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";

const BEARER_PREFIX = "Bearer ";
export const WORKER_TOKEN_HEADER = "x-agentr-token";

/** Generate a cryptographically strong worker auth token. */
export function generateWorkerToken(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

/** Generate a short human-friendly OTP pairing code (e.g. AB12-CD34). */
export function generatePairingCode(): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const buf = randomBytes(8);
  let out = "";
  for (let i = 0; i < 8; i++) {
    out += alphabet[buf[i]! % alphabet.length];
    if (i === 3) out += "-";
  }
  return out;
}

export function extractBearerToken(
  header: string | undefined | null,
): string | null {
  if (!header) return null;
  if (!header.startsWith(BEARER_PREFIX)) return null;
  const token = header.slice(BEARER_PREFIX.length).trim();
  return token.length > 0 ? token : null;
}

/** Resolve worker token from Authorization, x-agentr-token, or ?token= */
export function extractWorkerToken(req: IncomingMessage): string | null {
  const bearer = extractBearerToken(req.headers.authorization);
  if (bearer) return bearer;

  const custom = req.headers[WORKER_TOKEN_HEADER];
  const customVal = Array.isArray(custom) ? custom[0] : custom;
  if (customVal?.trim()) return customVal.trim();

  try {
    const host = req.headers.host ?? "localhost";
    const url = new URL(req.url ?? "/", `http://${host}`);
    const q = url.searchParams.get("token")?.trim();
    if (q) return q;
  } catch {
    /* ignore */
  }
  return null;
}

/** Constant-time string compare for tokens. */
export function safeEqualToken(a: string, b: string): boolean {
  const ha = createHash("sha256").update(a.trim()).digest();
  const hb = createHash("sha256").update(b.trim()).digest();
  return timingSafeEqual(ha, hb);
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token.trim()).digest("hex");
}
