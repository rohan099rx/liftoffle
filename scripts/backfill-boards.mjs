// Rebuild the This week / All-time boards (and everyone's XP) from all the history still in the database.
//
//   node scripts/backfill-boards.mjs            # dry run: prints what it would write
//   node scripts/backfill-boards.mjs --apply    # writes it
//
// Reads UPSTASH_REDIS_REST_URL / _TOKEN from .env.local (or the environment).
// Sources, de-duplicated by run id:
//   lb:{YYYY-MM-DD}  daily boards: each player's first daily run of the day (the only daily run that counts)
//   done:{runId}     finished runs from the last ~2 days (+ run:{runId} for player/mode/date): endless runs
//   runs:{player}    the per-player run log kept since profiles were added: endless runs
// It also rebuilds each player's run history (runs:{player}) from finished runs still in the database
// (run:{id} + done:{id}; daily tiers from lbg:{date}:{player}). Answer text from before profiles existed was
// never stored per player, so those entries have prompts, score and tiers but no answers.
// It never lowers a score: each player ends up with max(what the board has now, what the history adds up to).
import { readFileSync } from "node:fs";

const APPLY = process.argv.includes("--apply");
const env = { ...Object.fromEntries(readEnv(".env.local")), ...process.env };
const URL_ = env.UPSTASH_REDIS_REST_URL?.replace(/\/$/, ""), TOKEN = env.UPSTASH_REDIS_REST_TOKEN;
if (!URL_ || !TOKEN) { console.error("Missing UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN"); process.exit(1); }

function readEnv(file) {
  try { return readFileSync(file, "utf8").split("\n").map((l) => l.match(/^\s*([A-Z0-9_]+)\s*=\s*"?(.*?)"?\s*$/)).filter(Boolean).map((m) => [m[1], m[2]]); }
  catch { return []; }
}
async function redis(...cmd) {
  const r = await fetch(URL_, { method: "POST", headers: { Authorization: `Bearer ${TOKEN}` }, body: JSON.stringify(cmd) });
  const d = await r.json(); if (d.error) throw new Error(d.error); return d.result;
}
async function scan(pattern) {
  const out = []; let cursor = "0";
  do { const [c, keys] = await redis("SCAN", cursor, "MATCH", pattern, "COUNT", 1000); cursor = c; out.push(...keys); } while (cursor !== "0");
  return out;
}
const weekKey = (t = Date.now()) => { const d = new Date(t); d.setUTCHours(0, 0, 0, 0); d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7)); return d.toISOString().slice(0, 10); };
const parse = (s) => { try { return JSON.parse(s); } catch { return null; } };

const WEEK = weekKey();
const all = new Map(), week = new Map(), runsOf = new Map();
const seen = new Set();
const add = (player, score, date, src) => {
  if (!player || !(score > 0)) return;
  all.set(player, (all.get(player) ?? 0) + score);
  if (date >= WEEK) week.set(player, (week.get(player) ?? 0) + score);
  const r = runsOf.get(player) ?? { n: 0, best: 0, total: 0, src: new Set() };
  r.n++; r.best = Math.max(r.best, score); r.total += score; r.src.add(src); runsOf.set(player, r);
};

// 1) daily boards
const dailyKeys = (await scan("lb:*")).filter((k) => /^lb:\d{4}-\d{2}-\d{2}$/.test(k)).sort();
for (const k of dailyKeys) {
  const flat = await redis("ZRANGE", k, 0, -1, "WITHSCORES");
  for (let i = 0; i < flat.length; i += 2) add(flat[i], Number(flat[i + 1]), k.slice(3), "daily");
}
// 2) finished endless runs still in the database
const doneKeys = await scan("done:*");
const history = new Map(); // player -> finished runs rebuilt from run:/done:
for (const k of doneKeys) {
  const id = k.slice(5);
  const [score, run] = await Promise.all([redis("GET", k), redis("GET", `run:${id}`)]);
  const r = parse(run);
  if (r?.player) { const h = history.get(r.player) ?? []; h.push({ ...r, score: Number(parse(score)) }); history.set(r.player, h); }
  if (!r || r.mode !== "endless") continue;
  seen.add(id); add(r.player, Number(parse(score)), r.date, "endless");
}
// 3) per-player run logs (covers endless runs whose run record already expired)
for (const k of await scan("runs:*")) {
  const player = k.slice(5);
  for (const raw of await redis("LRANGE", k, 0, -1)) {
    const r = parse(raw);
    if (!r || r.mode !== "endless" || seen.has(r.run)) continue;
    seen.add(r.run); add(player, r.score, r.date, "endless");
  }
}

// compare with what the boards hold now, never lowering anyone
const ALL = "lb:all", WK = `lb:wk:${WEEK}`;
const rows = [];
for (const [player, pts] of all) {
  const [curAll, curWk] = await Promise.all([redis("ZSCORE", ALL, player), redis("ZSCORE", WK, player)]);
  const nextAll = Math.max(Number(curAll ?? 0), pts), nextWk = Math.max(Number(curWk ?? 0), week.get(player) ?? 0);
  rows.push({ player, nextAll, nextWk, curAll: Number(curAll ?? 0), curWk: Number(curWk ?? 0), runs: runsOf.get(player) });
}
rows.sort((a, b) => b.nextAll - a.nextAll);
const nick = async (id) => (parse(await redis("GET", `nick:${id}`)) ?? `Launcher ${id.slice(0, 4).toUpperCase()}`);

console.log(`daily boards: ${dailyKeys.join(", ") || "none"} · endless runs found: ${seen.size} · players: ${rows.length} · week starts ${WEEK}`);
for (const r of rows.slice(0, 25)) console.log(`  ${(await nick(r.player)).padEnd(16)} all ${String(r.curAll).padStart(6)} → ${String(r.nextAll).padStart(6)}   week ${String(r.curWk).padStart(6)} → ${String(r.nextWk).padStart(6)}   (${r.runs.n} runs)`);
if (rows.length > 25) console.log(`  …and ${rows.length - 25} more`);

console.log(`run histories to restore: ${[...history.values()].reduce((a, l) => a + l.length, 0)} finished runs across ${history.size} players`);
if (!APPLY) { console.log("\nDry run. Re-run with --apply to write."); process.exit(0); }

for (const r of rows) {
  await redis("ZADD", ALL, r.nextAll, r.player);
  if (r.nextWk > 0) await redis("ZADD", WK, r.nextWk, r.player);
  // XP follows all-time points; players from before profiles existed get one now
  const p = parse(await redis("GET", `profile:${r.player}`)) ?? {
    v: 1, id: r.player, created: Date.now(), lastSeen: Date.now(), played: r.runs.n, best: r.runs.best, total: r.runs.total,
  };
  p.xp = Math.max(Number(p.xp ?? 0), r.nextAll); p.lbSynced = true;
  await redis("SET", `profile:${r.player}`, JSON.stringify(p), "EX", 2 * 365 * 86400);
}
await redis("EXPIRE", WK, 60 * 86400);

// run histories: add finished runs that aren't in the player's log yet, oldest first so the list stays newest-first
let added = 0;
for (const [player, list] of history) {
  const have = new Set((await redis("LRANGE", `runs:${player}`, 0, -1)).map((x) => parse(x)?.run));
  for (const r of list.filter((x) => !have.has(x.id)).sort((a, b) => a.created - b.created)) {
    let tiers = r.prompts.map(() => null);
    if (r.mode === "daily") {
      const counted = Number(parse(await redis("GET", `daily-done:${r.date}:${player}`)) ?? -1);
      const grid = parse(await redis("GET", `lbg:${r.date}:${player}`));
      const T = { "⬜": "t1", "🟦": "t2", "🟩": "t3", "🟨": "t4", "🟪": "t5", "⬛": null };
      if (grid && counted === r.score) tiers = [...grid].filter((c) => c in T).map((c) => T[c]);
    }
    await redis("LPUSH", `runs:${player}`, JSON.stringify({ at: r.created, run: r.id, mode: r.mode, date: r.date, category: r.category, score: r.score, tiers, answers: r.prompts.map(() => null), prompts: r.prompts.map((p) => p.text), restored: true }));
    added++;
  }
  await redis("LTRIM", `runs:${player}`, 0, 999); await redis("EXPIRE", `runs:${player}`, 2 * 365 * 86400);
  // totals on the profile from the full history
  const p = parse(await redis("GET", `profile:${player}`)) ?? { v: 1, id: player, created: Date.now(), lastSeen: Date.now() };
  const n = list.length, best = Math.max(...list.map((x) => x.score)), total = list.reduce((a, x) => a + x.score, 0);
  if ((p.played ?? 0) < n) { p.played = n; p.total = Math.max(p.total ?? 0, total); }
  p.best = Math.max(p.best ?? 0, best);
  p.byMode = p.byMode ?? {}; for (const m of ["daily", "endless"]) p.byMode[m] = Math.max(p.byMode[m] ?? 0, list.filter((x) => x.mode === m).length);
  await redis("SET", `profile:${player}`, JSON.stringify(p), "EX", 2 * 365 * 86400);
}
console.log(`Restored ${added} past runs into ${history.size} players' run history.`);
console.log(`\nWrote ${rows.length} players to ${ALL} and ${WK}, and synced their XP.`);
