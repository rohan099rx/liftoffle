// Tiny key-value layer. Uses Upstash Redis (REST) when configured, otherwise an
// in-memory map (fine for local dev; NOT shared across serverless instances).
type Entry = { v: string; exp?: number };

const URL_ = process.env.UPSTASH_REDIS_REST_URL;
const TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;
export const usingRedis = Boolean(URL_ && TOKEN);

// Every database call gets a hard timeout: a reused connection that silently died (it happens on
// serverless) would otherwise hang the whole request, and any room lock it holds. Commands that are safe
// to repeat get one automatic retry; counters (INCR/ZINCRBY) and lock grabs (SET NX) never do.
const SAFE = new Set(["GET", "MGET", "SET", "DEL", "PUBLISH", "EXPIRE", "ZSCORE", "ZRANGE", "ZCOUNT", "ZCARD", "ZADD", "LRANGE", "LLEN", "ZMSCORE"]);
const retryable = (cmds: (string | number)[][]) => cmds.every((c) => SAFE.has(String(c[0]).toUpperCase()) && !c.some((x) => String(x).toUpperCase() === "NX"));
const DB_TIMEOUT_MS = 2500;

async function send(path: string, payload: unknown, canRetry: boolean): Promise<any> {
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await fetch(`${URL_!.replace(/\/$/, "")}${path}`, {
        method: "POST",
        headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        cache: "no-store",
        signal: AbortSignal.timeout(DB_TIMEOUT_MS),
      });
      if (!res.ok) throw new Error(`redis ${res.status}`);
      return await res.json();
    } catch (e) {
      // DOMException (timeouts/aborts) can't be re-labelled by error handlers: always throw a plain Error
      const err = e instanceof Error && e.constructor === Error ? e : new Error(`redis ${(e as Error)?.name === "TimeoutError" ? "timeout" : "unreachable"}: ${(e as Error)?.message ?? e}`);
      if (!canRetry || attempt >= 1) throw err;
      console.error("redis retry:", err.message);
    }
  }
}

async function redis(cmd: (string | number)[]): Promise<any> {
  const data = await send("", cmd, retryable([cmd]));
  if (data.error) throw new Error(`redis: ${data.error}`);
  return data.result;
}

/** Several commands in ONE round trip (Upstash /pipeline). Returns each command's result. */
async function pipeline(cmds: (string | number)[][]): Promise<any[]> {
  const data: { result?: any; error?: string }[] = await send("/pipeline", cmds, retryable(cmds));
  const err = data.find((d) => d.error);
  if (err) throw new Error(`redis: ${err.error}`);
  return data.map((d) => d.result);
}

// ---- in-memory fallback ----
const g = globalThis as any;
const mem: Map<string, Entry> = g.__liftoffMem ?? (g.__liftoffMem = new Map());
const hmem: Map<string, Map<string, number>> = g.__liftoffH ?? (g.__liftoffH = new Map());
const alive = (k: string) => {
  const e = mem.get(k);
  if (e && e.exp && e.exp < Date.now()) { mem.delete(k); return undefined; }
  return e;
};

export async function get<T = unknown>(key: string): Promise<T | null> {
  if (usingRedis) { const r = await redis(["GET", key]); return r == null ? null : JSON.parse(r); }
  const e = alive(key); return e ? JSON.parse(e.v) : null;
}

export async function set(key: string, value: unknown, ttlSec?: number): Promise<void> {
  const v = JSON.stringify(value);
  if (usingRedis) { await redis(ttlSec ? ["SET", key, v, "EX", ttlSec] : ["SET", key, v]); return; }
  mem.set(key, { v, exp: ttlSec ? Date.now() + ttlSec * 1000 : undefined });
}

/** Set only if missing. Returns true if this call set it (used as a lock / dedupe). */
export async function setNx(key: string, value: unknown, ttlSec: number): Promise<boolean> {
  const v = JSON.stringify(value);
  if (usingRedis) return (await redis(["SET", key, v, "NX", "EX", ttlSec])) === "OK";
  if (alive(key)) return false;
  mem.set(key, { v, exp: Date.now() + ttlSec * 1000 });
  return true;
}

export async function del(key: string): Promise<void> {
  if (usingRedis) { await redis(["DEL", key]); return; }
  mem.delete(key);
}

/** Add `by` to a counter (no retry: not safe to repeat). */
export async function incrBy(key: string, by: number, ttlSec: number): Promise<number> {
  if (usingRedis) { const [n] = await pipeline([["INCRBY", key, Math.round(by)], ["EXPIRE", key, ttlSec]]); return Number(n); }
  const e = alive(key); const n = (e ? Number(JSON.parse(e.v)) : 0) + Math.round(by);
  mem.set(key, { v: String(n), exp: e?.exp ?? Date.now() + ttlSec * 1000 }); return n;
}

/** Atomic counter with expiry set on first increment. */
export async function incr(key: string, ttlSec: number): Promise<number> {
  if (usingRedis) {
    const [n] = await pipeline([["INCR", key], ["EXPIRE", key, ttlSec]]);
    return Number(n);
  }
  const e = alive(key);
  const n = (e ? Number(JSON.parse(e.v)) : 0) + 1;
  mem.set(key, { v: String(n), exp: e?.exp ?? Date.now() + ttlSec * 1000 });
  return n;
}

// ---- sorted sets: answer counts per prompt, and leaderboards ----
export async function zincr(key: string, member: string, by: number, ttlSec: number): Promise<number> {
  if (usingRedis) {
    const [n] = await pipeline([["ZINCRBY", key, by, member], ["EXPIRE", key, ttlSec]]);
    return Number(n);
  }
  const h = hmem.get(key) ?? new Map<string, number>();
  hmem.set(key, h);
  const n = (h.get(member) ?? 0) + by;
  h.set(member, n);
  return n;
}

export async function zscore(key: string, member: string): Promise<number> {
  if (usingRedis) return Number((await redis(["ZSCORE", key, member])) ?? 0);
  return hmem.get(key)?.get(member) ?? 0;
}

/** Scores of many members in one round trip (0 for missing ones). */
export async function zscores(key: string, members: string[]): Promise<number[]> {
  if (!members.length) return [];
  if (usingRedis) return ((await redis(["ZMSCORE", key, ...members])) as (string | null)[]).map((x) => Number(x ?? 0));
  const h = hmem.get(key); return members.map((m) => h?.get(m) ?? 0);
}

/** Highest first: [[member, score], ...] */
export async function ztop(key: string, n: number): Promise<[string, number][]> {
  if (usingRedis) {
    const flat: string[] = await redis(["ZRANGE", key, 0, n - 1, "REV", "WITHSCORES"]);
    const out: [string, number][] = [];
    for (let i = 0; i < flat.length; i += 2) out.push([flat[i], Number(flat[i + 1])]);
    return out;
  }
  return [...(hmem.get(key) ?? new Map()).entries()].sort((a, b) => b[1] - a[1]).slice(0, n);
}

/** Number of members with a strictly higher score (0-based rank) and total size. */
export async function zrank(key: string, score: number): Promise<{ above: number; total: number }> {
  if (usingRedis) {
    const [above, total] = await pipeline([["ZCOUNT", key, `(${score}`, "+inf"], ["ZCARD", key]]);
    return { above: Number(above), total: Number(total) };
  }
  const vals = [...(hmem.get(key) ?? new Map()).values()];
  return { above: vals.filter((v) => v > score).length, total: vals.length };
}

export async function zset(key: string, member: string, score: number, ttlSec: number): Promise<void> {
  if (usingRedis) { await pipeline([["ZADD", key, score, member], ["EXPIRE", key, ttlSec]]); return; }
  const h = hmem.get(key) ?? new Map<string, number>();
  hmem.set(key, h);
  h.set(member, score);
}

// ---- live updates: Redis pub/sub (Upstash streams SUBSCRIBE over HTTP as server-sent events) ----
type Waiter = () => void;
const subs: Map<string, Set<Waiter>> = g.__liftoffSubs ?? (g.__liftoffSubs = new Map());

/** Save a value, release a lock and notify listeners, all in one round trip. */
export async function commit(key: string, value: unknown, ttlSec: number, unlock: string, channel: string, message: string): Promise<void> {
  const v = JSON.stringify(value);
  if (usingRedis) { await pipeline([["SET", key, v, "EX", ttlSec], ["DEL", unlock], ["PUBLISH", channel, message]]); return; }
  mem.set(key, { v, exp: Date.now() + ttlSec * 1000 }); mem.delete(unlock);
  for (const w of subs.get(channel) ?? []) w();
}

/**
 * Wait until something is published on `channel`, or `ms` passes, or `signal` aborts.
 * `ready` runs once the subscription is live (so nothing published after it can be missed);
 * if it returns true we stop straight away. Never throws.
 */
export async function waitForPublish(channel: string, ms: number, ready: () => Promise<boolean>, signal?: AbortSignal): Promise<"message" | "ready" | "timeout"> {
  if (!usingRedis) {
    let wake!: Waiter; const woke = new Promise<"message">((r) => (wake = () => r("message")));
    const set = subs.get(channel) ?? new Set(); subs.set(channel, set); set.add(wake);
    try {
      if (await ready()) return "ready";
      return await Promise.race([woke, new Promise<"timeout">((r) => { const t = setTimeout(() => r("timeout"), ms); signal?.addEventListener("abort", () => { clearTimeout(t); r("timeout"); }); })]);
    } finally { set.delete(wake); if (!set.size) subs.delete(channel); }
  }
  const ac = new AbortController();
  const stopAll = () => ac.abort();
  const timer = setTimeout(stopAll, ms);
  signal?.addEventListener("abort", stopAll);
  try {
    const res = await fetch(`${URL_!.replace(/\/$/, "")}/subscribe/${encodeURIComponent(channel)}`, {
      headers: { Authorization: `Bearer ${TOKEN}`, Accept: "text/event-stream" }, signal: ac.signal, cache: "no-store",
    });
    if (!res.ok || !res.body) throw new Error(`subscribe ${res.status}`);
    const reader = res.body.getReader(); const dec = new TextDecoder(); let buf = "", subscribed = false;
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return "timeout";
      buf += dec.decode(value, { stream: true });
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);
        if (!line.startsWith("data:")) continue;
        const kind = line.slice(5).trim().split(",")[0];
        if (kind === "subscribe" && !subscribed) { subscribed = true; if (await ready()) return "ready"; }
        else if (kind === "message") return "message";
      }
    }
  } catch {
    if (ac.signal.aborted) return "timeout";
    // pub/sub unavailable: behave like a short poll so the caller still makes progress
    if (await ready().catch(() => false)) return "ready";
    await new Promise((r) => setTimeout(r, Math.min(ms, 700)));
    return "timeout";
  } finally { clearTimeout(timer); signal?.removeEventListener("abort", stopAll); ac.abort(); }
}

/** Read many keys in one round trip. Missing keys come back as null. */
export async function mget<T = unknown>(keys: string[]): Promise<(T | null)[]> {
  if (!keys.length) return [];
  if (usingRedis) return ((await redis(["MGET", ...keys])) as (string | null)[]).map((v) => (v == null ? null : JSON.parse(v)));
  return keys.map((k) => { const e = alive(k); return e ? JSON.parse(e.v) : null; });
}

// ---- capped lists: a player's answer log and run history (newest first, kept forever unless a TTL is given) ----
const lmem: Map<string, string[]> = g.__liftoffL ?? (g.__liftoffL = new Map());

/** Add to the front of a list and keep only the newest `max` entries. */
export async function lpushCap(key: string, value: unknown, max: number, ttlSec?: number): Promise<void> {
  const v = JSON.stringify(value);
  if (usingRedis) {
    const cmds: (string | number)[][] = [["LPUSH", key, v], ["LTRIM", key, 0, max - 1]];
    if (ttlSec) cmds.push(["EXPIRE", key, ttlSec]);
    await pipeline(cmds); return;
  }
  const l = lmem.get(key) ?? []; l.unshift(v); lmem.set(key, l.slice(0, max));
}

/** Entries `start`..`stop` (inclusive, 0 = newest). */
export async function lrange<T = unknown>(key: string, start: number, stop: number): Promise<T[]> {
  const raw: string[] = usingRedis ? await redis(["LRANGE", key, start, stop]) : (lmem.get(key) ?? []).slice(start, stop + 1);
  return (raw ?? []).flatMap((x) => { try { return [JSON.parse(x) as T]; } catch { return []; } });
}

export async function llen(key: string): Promise<number> {
  if (usingRedis) return Number(await redis(["LLEN", key]));
  return lmem.get(key)?.length ?? 0;
}
