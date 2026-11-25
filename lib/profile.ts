import "server-only";
import * as kv from "./store";
import { dailyReward, levelFor, MAX_BOOSTS, weekKey } from "./progress";

// Everything we know about one player, kept server-side (Redis) instead of only in their browser.
// Keyed by the player id in the signed, HttpOnly cookie. Three records per player:
//   profile:{id}   running totals (one JSON document)
//   answers:{id}   every answer attempt, newest first (accepted, rejected and skipped; solo and party)
//   runs:{id}      every finished solo run, newest first
// No IP addresses or device details are stored.

const YEAR = 365 * 86400;
const PROFILE_TTL = 2 * YEAR; // refreshed on every write, so only players gone for 2 years expire
const MAX_ANSWERS = 3000, MAX_RUNS = 1000;
const pk = (id: string) => `profile:${id}`, ak = (id: string) => `answers:${id}`, rk = (id: string) => `runs:${id}`;

export type Mode = "daily" | "endless" | "party";
export type AnswerLog = {
  at: number; mode: Mode; run: string; round: number;
  prompt: string; promptId: string; category: string;
  typed: string | null;          // exactly what the player typed (null = skipped)
  valid: boolean;
  answer?: string;               // the judge's canonical name, when accepted
  tier?: string | null; share?: number; score?: number;
  hint?: boolean; skipped?: boolean;
  fail?: string; reason?: string; // why it was refused
  final?: boolean;               // this attempt ended the round
};
export type RunLog = {
  at: number; run: string; mode: Exclude<Mode, "party">; date: string; category: string;
  score: number; tiers: (string | null)[]; answers: (string | null)[]; prompts: string[];
};
export type Profile = {
  v: 1; id: string; created: number; lastSeen: number;
  name: string | null; names: string[];                       // current board name and earlier ones
  played: number; best: number; total: number;                // finished solo runs
  byMode: Record<string, number>;                             // runs per mode
  tiers: Record<string, number>;                              // round outcomes: t1..t5 and "miss"
  categories: Record<string, number>;                         // accepted answers per category
  attempts: number; accepted: number; rejected: number; skipped: number; hints: number;
  fails: Record<string, number>;                              // rejections by reason
  rarest: { answer: string; prompt: string; share: number; at: number } | null;
  badges: Record<string, number>;
  xp: number;                                                 // lifetime points that count on the all-time board
  boosts: number; boostsUsed: number;                         // free hints that keep full points
  checkin: { last: string; n: number; best: number };         // daily-bonus streak
  sights: Record<string, number>;                             // Sky Log: things spotted on the way up, and when
  lbSynced?: boolean;                                         // points from before the all-time board was added are on it
  legacy?: { played: number; best: number; total: number; tiers: Record<string, number>; at: number }; // imported from this browser's old local stats
};

export const emptyProfile = (id: string): Profile => ({
  v: 1, id, created: Date.now(), lastSeen: Date.now(), name: null, names: [],
  played: 0, best: 0, total: 0, byMode: {}, tiers: {}, categories: {},
  attempts: 0, accepted: 0, rejected: 0, skipped: 0, hints: 0, fails: {}, rarest: null, badges: {},
  xp: 0, boosts: 1, boostsUsed: 0, checkin: { last: "", n: 0, best: 0 }, sights: {}, // everyone starts with one boost to try
});

export async function getProfile(id: string): Promise<Profile> {
  const p = await kv.get<Profile>(pk(id)).catch(() => null);
  return p ? { ...emptyProfile(id), ...p } : emptyProfile(id);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** Read-modify-write under a short per-player lock, so an answer and a run finishing together don't overwrite each other. */
export async function updateProfile(id: string, fn: (p: Profile) => void): Promise<Profile> {
  const lock = `lock:${pk(id)}`;
  let locked = false;
  for (let i = 0; i < 40 && !locked; i++) { locked = await kv.setNx(lock, 1, 5).catch(() => true); if (!locked) await sleep(30 + Math.random() * 40); }
  try {
    const p = await getProfile(id);
    fn(p);
    p.lastSeen = Date.now();
    await kv.set(pk(id), p, PROFILE_TTL);
    return p;
  } finally { if (locked) await kv.del(lock).catch(() => {}); }
}

const bump = (m: Record<string, number>, k: string, by = 1) => { m[k] = (m[k] ?? 0) + by; };

/** Log one answer attempt and fold it into the totals. Returns whether it is the player's rarest accepted answer ever. */
export async function logAnswer(id: string, a: Omit<AnswerLog, "at">): Promise<{ rarestEver: boolean }> {
  const entry: AnswerLog = { at: Date.now(), ...a };
  let rarestEver = false;
  try {
    await Promise.all([
      kv.lpushCap(ak(id), entry, MAX_ANSWERS, PROFILE_TTL),
      updateProfile(id, (p) => {
        if (a.skipped) { p.skipped++; return; }
        p.attempts++;
        if (a.hint && a.final) p.hints++;
        if (!a.valid) { p.rejected++; bump(p.fails, a.fail ?? "made_up"); return; }
        p.accepted++;
        bump(p.categories, a.category || "anything");
        if (a.answer && typeof a.share === "number" && (!p.rarest || a.share < p.rarest.share)) {
          rarestEver = p.accepted > 1 && a.share < 3; // the first answer is trivially the "rarest", and common ones aren't worth a party
          p.rarest = { answer: a.answer, prompt: a.prompt, share: a.share, at: entry.at };
        }
      }),
    ]);
  } catch (e) { console.error("logAnswer:", (e as Error).message); }
  return { rarestEver };
}

// ---- leaderboards over time: every solo point counts (a daily run only once per day)
export const ALL_TIME = "lb:all", weekBoard = (w = weekKey()) => `lb:wk:${w}`;
const LB_TTL = 10 * YEAR, WEEK_TTL = 60 * 86400;

// ---- milestone achievements, checked on the server from the stored profile
export const MILESTONES: { id: string; ok: (p: Profile) => boolean }[] = [
  { id: "ten_flights", ok: (p) => p.played >= 10 },
  { id: "fifty_flights", ok: (p) => p.played >= 50 },
  { id: "hundred_flights", ok: (p) => p.played >= 100 },
  { id: "k_points", ok: (p) => p.xp >= 1000 },
  { id: "ten_k_points", ok: (p) => p.xp >= 10000 },
  { id: "century", ok: (p) => p.accepted >= 100 },
  { id: "explorer", ok: (p) => Object.keys(p.categories).length >= 6 },
  { id: "loyal", ok: (p) => p.checkin.best >= 7 },
  { id: "level_five", ok: (p) => levelFor(p.xp).level >= 5 },
  { id: "level_ten", ok: (p) => levelFor(p.xp).level >= 10 },
];
function awardMilestones(p: Profile): string[] {
  const fresh = MILESTONES.filter((m) => !p.badges[m.id] && m.ok(p)).map((m) => m.id);
  for (const id of fresh) p.badges[id] = Date.now();
  return fresh;
}

export type RunReward = { xpGained: number; xp: number; levelBefore: number; levelAfter: number; boostsEarned: number; boosts: number; newBadges: string[]; counted: boolean };

/** Record a finished solo run (call once per run). `counts` = its points go on the week/all-time boards and into XP. */
export async function logRun(id: string, r: Omit<RunLog, "at">, counts: boolean): Promise<RunReward | null> {
  try {
    let reward!: RunReward;
    await Promise.all([
      kv.lpushCap(rk(id), { at: Date.now(), ...r }, MAX_RUNS, PROFILE_TTL),
      updateProfile(id, (p) => {
        p.played++; p.total += r.score; p.best = Math.max(p.best, r.score);
        bump(p.byMode, r.mode);
        for (const t of r.tiers) bump(p.tiers, t ?? "miss");
        const before = levelFor(p.xp).level;
        if (counts) p.xp += r.score;
        const after = levelFor(p.xp).level;
        const boostsEarned = Math.max(0, Math.min(after - before, MAX_BOOSTS - p.boosts)); // one boost per level up
        p.boosts += boostsEarned;
        reward = { xpGained: counts ? r.score : 0, xp: p.xp, levelBefore: before, levelAfter: after, boostsEarned, boosts: p.boosts, newBadges: awardMilestones(p), counted: counts };
      }),
      counts && r.score > 0 ? kv.zincr(ALL_TIME, id, r.score, LB_TTL) : null,
      counts && r.score > 0 ? kv.zincr(weekBoard(), id, r.score, WEEK_TTL) : null,
    ]);
    return reward;
  } catch (e) { console.error("logRun:", (e as Error).message); return null; }
}

/** Points earned before the all-time board existed go onto it once. */
export async function syncAllTime(id: string) {
  const p = await getProfile(id);
  if (p.lbSynced) return;
  await updateProfile(id, (q) => { if (!q.xp) q.xp = q.total; q.lbSynced = true; });
  if (p.total > 0 && !(await kv.zscore(ALL_TIME, id))) await kv.zincr(ALL_TIME, id, p.total, LB_TTL);
}

/** The daily bonus: once per UTC day, more for keeping a streak. */
export async function claimDaily(id: string, today: string) {
  let out: { ok: boolean; streak: number; boosts: number; gained: number; label: string; newBadges: string[] } | null = null;
  await updateProfile(id, (p) => {
    if (p.checkin.last === today) { out = { ok: false, streak: p.checkin.n, boosts: p.boosts, gained: 0, label: "", newBadges: [] }; return; }
    const yesterday = new Date(Date.parse(today) - 864e5).toISOString().slice(0, 10);
    const n = p.checkin.last === yesterday ? p.checkin.n + 1 : 1;
    const rw = dailyReward(n);
    const gained = Math.min(rw.boosts, MAX_BOOSTS - p.boosts);
    p.boosts += gained;
    p.checkin = { last: today, n, best: Math.max(p.checkin.best, n) };
    out = { ok: true, streak: n, boosts: p.boosts, gained, label: rw.label, newBadges: awardMilestones(p) };
  });
  return out!;
}

/** Spend one boost. False if the player has none. */
export async function spendBoost(id: string): Promise<boolean> {
  let ok = false;
  await updateProfile(id, (p) => { if (p.boosts > 0) { p.boosts--; p.boostsUsed++; ok = true; } });
  return ok;
}

export async function logName(id: string, name: string) {
  await updateProfile(id, (p) => {
    if (p.name && p.name !== name && !p.names.includes(p.name)) p.names = [...p.names, p.name].slice(-20);
    p.name = name;
  }).catch((e) => console.error("logName:", (e as Error).message));
}

const BADGE_ID = /^[a-z_]{2,24}$/;
export async function addBadges(id: string, badges: Record<string, unknown>) {
  const ok = Object.entries(badges).filter(([k, t]) => BADGE_ID.test(k) && Number.isFinite(Number(t))).slice(0, 60);
  if (!ok.length) return getProfile(id);
  return updateProfile(id, (p) => { for (const [k, t] of ok) if (!p.badges[k]) p.badges[k] = Math.min(Date.now(), Number(t)); });
}

/** Sky Log: record things spotted while climbing. */
export async function addSights(id: string, ids: unknown) {
  const ok = (Array.isArray(ids) ? ids : []).filter((x): x is string => typeof x === "string" && BADGE_ID.test(x)).slice(0, 40);
  if (!ok.length) return getProfile(id);
  return updateProfile(id, (p) => { for (const k of ok) p.sights[k] ??= Date.now(); });
}

/** One-time import of the stats this browser kept before they moved to the server. Personal only: never touches leaderboards. */
export async function importLegacy(id: string, s: any) {
  const n = (x: unknown, max: number) => Math.max(0, Math.min(max, Math.floor(Number(x) || 0)));
  return updateProfile(id, (p) => {
    if (p.legacy) return;
    const tiers: Record<string, number> = {};
    for (const k of ["t1", "t2", "t3", "t4", "t5", "miss"]) tiers[k] = n(s?.tiers?.[k], 20000);
    p.legacy = { played: n(s?.played, 3000), best: n(s?.best, 700), total: n(s?.total, 2_000_000), tiers, at: Date.now() };
  });
}

export const recentAnswers = (id: string, n = 50) => kv.lrange<AnswerLog>(ak(id), 0, n - 1);
export const recentRuns = (id: string, n = 30) => kv.lrange<RunLog>(rk(id), 0, n - 1);
export const answerCount = (id: string) => kv.llen(ak(id));
