import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { incr } from "./store";

// Checked when used (not at import) so `next build` works without secrets present.
function secret(): string {
  const s = process.env.RECEIPT_SECRET || "";
  if (s.length >= 32) return s;
  if (process.env.NODE_ENV === "production") throw new Error("RECEIPT_SECRET must be set to 32+ random characters.");
  return "dev-only-secret-change-me-dev-only-secret";
}

const b64u = (b: Buffer | string) => Buffer.from(b).toString("base64url");
const mac = (data: string) => createHmac("sha256", secret()).update(data).digest();

export function sign(payload: object): string {
  const body = b64u(JSON.stringify(payload));
  return `${body}.${b64u(mac(body))}`;
}

export function verify<T = any>(token: unknown): T | null {
  if (typeof token !== "string" || token.length > 2000) return null;
  const i = token.lastIndexOf(".");
  if (i <= 0) return null;
  const body = token.slice(0, i);
  const sig = Buffer.from(token.slice(i + 1), "base64url");
  const want = mac(body);
  if (sig.length !== want.length || !timingSafeEqual(sig, want)) return null;
  try { return JSON.parse(Buffer.from(body, "base64url").toString("utf8")); } catch { return null; }
}

// ---- player identity: signed, httpOnly cookie (not readable by page scripts) ----
export const PLAYER_COOKIE = "lo_pid";

export function playerFrom(req: Request): { id: string; setCookie?: string } {
  const raw = (req.headers.get("cookie") || "")
    .split(/;\s*/).find((c) => c.startsWith(PLAYER_COOKIE + "="))?.slice(PLAYER_COOKIE.length + 1);
  const v = raw ? verify<{ p: string }>(decodeURIComponent(raw)) : null;
  if (v?.p && /^[0-9a-f-]{36}$/.test(v.p)) return { id: v.p };
  const id = randomUUID();
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
  return {
    id,
    setCookie: `${PLAYER_COOKIE}=${encodeURIComponent(sign({ p: id }))}; Path=/; HttpOnly; SameSite=Lax; Max-Age=31536000${secure}`,
  };
}

export function clientIp(req: Request): string {
  return (req.headers.get("x-forwarded-for") || "").split(",")[0].trim() || req.headers.get("x-real-ip") || "local";
}

/** Fixed-window rate limit. Returns true when the caller is OVER the limit. */
export async function limited(bucket: string, who: string, max: number, windowSec: number): Promise<boolean> {
  const win = Math.floor(Date.now() / 1000 / windowSec);
  // if the database is having a moment, let the request through rather than failing it
  try { return (await incr(`rl:${bucket}:${who}:${win}`, windowSec + 5)) > max; } catch { return false; }
}

/** Same-origin check for state-changing requests (defence in depth on top of SameSite cookies). */
export function sameOrigin(req: Request): boolean {
  const origin = req.headers.get("origin");
  if (!origin) return true; // non-browser clients; still rate-limited + receipt-checked
  try { return new URL(origin).host === (req.headers.get("x-forwarded-host") || req.headers.get("host")); } catch { return false; }
}

export function json(data: unknown, init: ResponseInit & { cookie?: string } = {}): Response {
  const headers = new Headers(init.headers);
  headers.set("Content-Type", "application/json");
  headers.set("Cache-Control", "no-store");
  if (init.cookie) headers.append("Set-Cookie", init.cookie);
  return new Response(JSON.stringify(data), { status: init.status ?? 200, headers });
}

/** Read a JSON body with a hard size cap. */
export async function body<T = any>(req: Request, maxBytes = 4096): Promise<T | null> {
  const text = await req.text();
  if (text.length > maxBytes) return null;
  try { return JSON.parse(text); } catch { return null; }
}

// In-memory limiter for very frequent, read-only calls (live-update polls). It's per server instance,
// so it's looser than `limited`, but it costs no database round trip on the hottest path.
const localHits: Map<string, { n: number; win: number }> = ((globalThis as any).__loLocalHits ??= new Map());
export function limitedLocal(bucket: string, who: string, max: number, windowSec: number): boolean {
  const win = Math.floor(Date.now() / 1000 / windowSec), k = `${bucket}:${who}`;
  const e = localHits.get(k);
  if (!e || e.win !== win) {
    if (localHits.size > 5000) localHits.clear();
    localHits.set(k, { n: 1, win });
    return false;
  }
  return ++e.n > max;
}
