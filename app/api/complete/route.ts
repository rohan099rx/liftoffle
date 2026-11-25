import { dayKey, getRun, type Receipt } from "@/lib/game";
import { body, json, playerFrom, sameOrigin, verify } from "@/lib/security";
import * as kv from "@/lib/store";
import { cleanNick, nickProblem, saveNick } from "@/lib/nick";
import { after } from "next/server";
import { logName, logRun } from "@/lib/profile";

export const dynamic = "force-dynamic";


// Score is recomputed from signed receipts. The client never sends a score.
export async function POST(req: Request) {
  if (!sameOrigin(req)) return json({ error: "bad-origin" }, { status: 403 });
  const p = playerFrom(req);
  const c = p.setCookie;
  const b = await body<{ runId?: string; receipts?: string[]; nickname?: string }>(req, 8192);
  const run = await getRun(b?.runId);
  if (!run || run.player !== p.id) return json({ error: "Run not found." }, { status: 404, cookie: c });
  const recs = (Array.isArray(b?.receipts) ? b!.receipts : []).map((t) => verify<Receipt>(t));
  const rounds = new Set<number>();
  for (const r of recs) {
    if (!r || r.run !== run.id || r.player !== p.id || r.prompt !== run.prompts[r.round]?.id || rounds.has(r.round))
      return json({ error: "Invalid receipt." }, { status: 400, cookie: c });
    rounds.add(r.round);
  }
  if (rounds.size !== run.prompts.length) return json({ error: "Finish every prompt first." }, { status: 400, cookie: c });
  const score = recs.reduce((s, r) => s + r!.score, 0);
  const firstTime = await kv.setNx(`done:${run.id}`, score, 2 * 86400);
  const ordered = [...recs].sort((a, b) => a!.round - b!.round);
  // XP + week/all-time boards: every endless run, and only the first daily run of the day (no replaying known answers)
  const record = (counts: boolean) => firstTime ? logRun(p.id, {
    run: run.id, mode: run.mode, date: run.date, category: run.category, score,
    tiers: ordered.map((r) => r!.tier), answers: ordered.map((r) => r!.answer), prompts: run.prompts.map((x) => x.text),
  }, counts) : Promise.resolve(null);

  if (run.mode !== "daily") return json({ score, reward: await record(true) }, { cookie: c });
  let firstDaily = false;

  const lb = `lb:${run.date}`;
  const nick = cleanNick(b?.nickname);
  if (firstTime && run.date === dayKey()) {
    // one leaderboard entry per player per day: their first completed daily run
    if (await kv.setNx(`daily-done:${run.date}:${p.id}`, score, 3 * 86400)) {
      firstDaily = true;
      const EMOJI: Record<string, string> = { t1: "⬜", t2: "🟦", t3: "🟩", t4: "🟨", t5: "🟪" };
      const grid = [...recs].sort((a, b) => a!.round - b!.round).map((r) => EMOJI[r!.tier ?? ""] ?? "⬛").join("");
      await Promise.all([kv.zset(lb, p.id, score, 3 * 86400), kv.set(`lbg:${run.date}:${p.id}`, grid, 3 * 86400)]);
      // streak
      const st = (await kv.get<{ last: string; n: number; best: number }>(`streak:${p.id}`)) ?? { last: "", n: 0, best: 0 };
      const yesterday = new Date(Date.parse(run.date) - 864e5).toISOString().slice(0, 10);
      const n = st.last === yesterday ? st.n + 1 : st.last === run.date ? st.n : 1;
      await kv.set(`streak:${p.id}`, { last: run.date, n, best: Math.max(st.best, n) }, 400 * 86400);
    }
  }
  const reward = await record(firstDaily);
  // the name can be set (or changed) at any time; also accept it here so finishing with a name typed in works
  if (nick && !nickProblem(nick)) { await saveNick(p.id, nick); after(() => logName(p.id, nick)); }
  const counted = (await kv.get<number>(`daily-done:${run.date}:${p.id}`)) ?? score;
  const { above, total } = await kv.zrank(lb, counted);
  const streak = await kv.get<{ n: number; best: number }>(`streak:${p.id}`);
  return json({
    score, counted, rank: above + 1, players: total,
    beat: total > 1 ? Math.round(((total - above - 1) / (total - 1)) * 100) : 100,
    streak: streak?.n ?? 0, bestStreak: streak?.best ?? 0, reward,
  }, { cookie: c });
}
