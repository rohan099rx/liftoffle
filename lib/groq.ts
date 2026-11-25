// Server-only Groq client. The API key never leaves the server.
import "server-only";
import * as kv from "./store";

const KEY = process.env.GROQ_API_KEY || "";
const BASE = (process.env.GROQ_BASE_URL || "https://api.groq.com/openai/v1").replace(/\/$/, "");
/** Highest-quality model (prompt writing fallback, judge fallback). */
export const MODEL = process.env.GROQ_MODEL || "openai/gpt-oss-120b";
/** Background work (writing prompts, rarity surveys, hints). */
export const FAST_MODEL = process.env.GROQ_FAST_MODEL || "openai/gpt-oss-20b";
/** Judging answers: players wait on this. Qwen answers in ~0.25s and uses few tokens. */
export const JUDGE_MODEL = process.env.GROQ_JUDGE_MODEL || "qwen/qwen3.8-27b";
export const mockMode = process.env.GROQ_MOCK === "1" || !KEY;

// Every Groq model has its own rate limits (on the free tier: ~8k tokens/minute and ~200k tokens/day).
// When a model is out of quota we remember it until its reset time and skip it instantly,
// instead of asking again (and waiting) on every request.
const benched: Map<string, number> = ((globalThis as any).__loBenched ??= new Map());
const available = (m: string) => (benched.get(m) ?? 0) < Date.now();
function bench(model: string, res: Response, body: string) {
  const retry = Number(res.headers.get("retry-after")) || 0;
  // "...Please try again in 4m17.47s" also appears in the body for daily limits
  const m = body.match(/try again in (?:(\d+)h)?(?:(\d+)m)?(?:([\d.]+)s)?/);
  const fromBody = m ? (Number(m[1] || 0) * 3600 + Number(m[2] || 0) * 60 + Number(m[3] || 0)) : 0;
  const secs = Math.max(retry, fromBody, 2);
  benched.set(model, Date.now() + Math.min(secs, 6 * 3600) * 1000);
  // a daily-limit reply says exactly how much was used: correct our own count so lanes see the truth
  const tpd = body.match(/tokens per day[^]*?Limit (\d+), Used (\d+)/);
  // (kept for 30 minutes only: Groq's window rolls, so this figure goes stale fast)
  if (tpd) { const real = Number(tpd[2]); const c = used.get(model); used.set(model, { n: Math.max(c?.n ?? 0, real), at: Date.now() }); void kv.set(corrKey(model), real, 1800).catch(() => {}); }
}
// ---- daily token budget, with priority lanes
// Groq's free tier gives each model ~200k tokens per rolling 24h. We count what we spend (per model, per hour,
// shared by every server instance through Redis) so background work can't starve the judge that players wait on.
//   judge      players are waiting on it: may use the whole allowance
//   background prompt writing, rarity surveys, hints: stops at 80%
//   extra      nice-to-haves (fun facts, pilot profile): stops at 55%
export type Lane = "judge" | "background" | "extra";
const DAILY = Number(process.env.GROQ_DAILY_TOKENS) || 200_000;
// The judge is never held back by our own estimate: it only stops when Groq itself says the limit is reached.
const LANE_SHARE: Record<Lane, number> = { judge: Infinity, background: 0.8, extra: 0.55 };
const hourKey = (m: string, h: number) => `ai:tok:${m}:${h}`;
const corrKey = (m: string) => `ai:tpd:${m}`; // what Groq itself last reported as used (short-lived)
const used: Map<string, { n: number; at: number }> = ((globalThis as any).__loUsed ??= new Map());
/** Tokens this model spent in the last 24 hours (cached for 20s per server instance). */
async function used24h(model: string): Promise<number> {
  const c = used.get(model);
  if (c && Date.now() - c.at < 20_000) return c.n;
  const h = Math.floor(Date.now() / 3.6e6);
  const vals = await kv.mget<number>([corrKey(model), ...Array.from({ length: 24 }, (_, i) => hourKey(model, h - i))]).catch(() => [] as (number | null)[]);
  const n = Math.max(Number(vals[0]) || 0, vals.slice(1).reduce<number>((a, v) => a + (Number(v) || 0), 0));
  used.set(model, { n, at: Date.now() });
  return n;
}
function spend(model: string, tokens: number) {
  if (!(tokens > 0)) return;
  const c = used.get(model); if (c) c.n += tokens;
  const k = hourKey(model, Math.floor(Date.now() / 3.6e6));
  void kv.incrBy(k, tokens, 26 * 3600).catch(() => {});
}
/** Is there room in this lane on this model right now? */
async function laneOpen(model: string, lane: Lane) { return (await used24h(model)) < DAILY * LANE_SHARE[lane]; }
/** For the status page / logs: % of each model's daily allowance used. */
export async function budgetStatus() {
  return Object.fromEntries(await Promise.all([JUDGE_MODEL, FAST_MODEL, MODEL].map(async (m) => [m, `${Math.round(((await used24h(m)) / DAILY) * 100)}%`])));
}
/** True if at least one of `models` can take `lane` work now (lets callers skip optional AI calls cheaply). */
export async function laneAvailable(models: string[], lane: Lane) {
  for (const m of models) if (available(m) && (await laneOpen(m, lane))) return true;
  return false;
}

export const modelStatus = () => Object.fromEntries([MODEL, FAST_MODEL, JUDGE_MODEL].map((m) => [m, available(m) ? "ok" : `resting ${Math.round(((benched.get(m) ?? 0) - Date.now()) / 1000)}s`]));

type Msg = { role: "system" | "user"; content: string };
type Opts = { temperature?: number; timeoutMs?: number; models?: string[]; maxTokens?: number; budgetMs?: number; lane?: Lane };

/**
 * Chat completion constrained to a JSON schema. Tries each model in `models` in order, skipping any that
 * are out of quota. A short per-minute limit on every model gets one brief wait; a daily limit never does.
 */
export async function groqJson<T>(messages: Msg[], name: string, schema: object, opts: Opts = {}): Promise<T> {
  if (mockMode) throw new Error("groq: mock mode");
  const chain = [...new Set(opts.models ?? [MODEL])];
  const giveUpAt = Date.now() + (opts.budgetMs ?? 9000);
  let lastErr: unknown = new Error("groq: every model is out of quota right now");

  for (let pass = 0; pass < 2 && Date.now() < giveUpAt; pass++) {
    for (const model of chain) {
      if (!available(model) || Date.now() >= giveUpAt) continue;
      if (!(await laneOpen(model, opts.lane ?? "background"))) { lastErr = new Error(`groq: ${model} saving its budget for the judge`); continue; }
      const payload: Record<string, unknown> = {
        model, messages,
        temperature: opts.temperature ?? 0.2,
        max_completion_tokens: opts.maxTokens ?? 3000,
        response_format: { type: "json_schema", json_schema: { name, strict: true, schema } },
      };
      if (model.startsWith("openai/gpt-oss")) payload.reasoning_effort = "low";
      if (model.startsWith("qwen/")) payload.reasoning_effort = "none";
      try {
        const res = await fetch(`${BASE}/chat/completions`, {
          method: "POST",
          headers: { Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" },
          body: JSON.stringify(payload),
          signal: AbortSignal.timeout(Math.max(1000, Math.min(opts.timeoutMs ?? 12000, giveUpAt - Date.now()))),
          cache: "no-store",
        });
        if (res.status === 429) { bench(model, res, await res.text()); lastErr = new Error(`groq 429 (${model})`); continue; }
        if (res.status === 400 && model.startsWith("qwen/")) { // e.g. a parameter this model doesn't accept
          lastErr = new Error(`groq 400 (${model}): ${(await res.text()).slice(0, 160)}`); benched.set(model, Date.now() + 600_000); continue;
        }
        if (!res.ok) { lastErr = new Error(`groq ${res.status} (${model}): ${(await res.text()).slice(0, 160)}`); continue; }
        const data = await res.json();
        spend(model, Number(data?.usage?.total_tokens) || 0);
        const content = data?.choices?.[0]?.message?.content;
        if (typeof content !== "string") { lastErr = new Error("groq: empty response"); continue; }
        return JSON.parse(content) as T;
      } catch (e) { lastErr = e; }
    }
    // every model is resting: if one comes back within ~2.5s (per-minute limit), wait for it once
    const soonest = Math.min(...chain.map((m) => benched.get(m) ?? 0));
    const wait = soonest - Date.now();
    if (wait > 0 && wait < 2500 && Date.now() + wait < giveUpAt) await new Promise((r) => setTimeout(r, wait + 50));
    else break;
  }
  throw lastErr;
}
