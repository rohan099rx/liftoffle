import { dayKey } from "@/lib/game";
import { fallbackName, nickKey } from "@/lib/nick";
import { json, limitedLocal, playerFrom } from "@/lib/security";
import * as kv from "@/lib/store";
import { ALL_TIME, weekBoard } from "@/lib/profile";
import { levelFor, weekKey } from "@/lib/progress";

export const dynamic = "force-dynamic";
const TOP = 50;

// GET /api/leaderboard?day=today|yesterday|week|all
export async function GET(req: Request) {
  const p = playerFrom(req), c = p.setCookie;
  if (limitedLocal("board", p.id, 120, 60)) return json({ error: "Slow down a little." }, { status: 429, cookie: c });
  const day = new URL(req.url).searchParams.get("day");
  if (day === "week" || day === "all") return overall(p.id, day, c);
  const yesterday = day === "yesterday";
  const date = yesterday ? new Date(Date.parse(dayKey()) - 864e5).toISOString().slice(0, 10) : dayKey();
  const lb = `lb:${date}`;
  const [top, mine] = await Promise.all([kv.ztop(lb, TOP), kv.zscore(lb, p.id)]);
  const ids = top.map(([id]) => id);
  const inTop = ids.includes(p.id);
  const [names, grids, myName, place] = await Promise.all([
    kv.mget<string>(ids.map(nickKey)),
    kv.mget<string>(ids.map((id) => `lbg:${date}:${id}`)),
    kv.get<string>(nickKey(p.id)),
    kv.zrank(lb, mine),
  ]);
  // ties share a rank: rank = 1 + number of strictly higher scores
  const rows = top.map(([id, score], i) => ({
    rank: 1 + top.findIndex(([, s]) => s === score), score,
    name: names[i] || fallbackName(id), grid: grids[i] ?? "", you: id === p.id, named: !!names[i],
  }));
  const played = mine > 0 || inTop || (await kv.get(`daily-done:${date}:${p.id}`)) !== null;
  const me = played ? { rank: place.above + 1, score: mine, name: myName || fallbackName(p.id), named: !!myName, grid: (await kv.get<string>(`lbg:${date}:${p.id}`)) ?? "", inTop } : null;
  return json({ date, day: yesterday ? "yesterday" : "today", players: place.total, rows, me, myName }, { cookie: c });
}

/** Overall boards: every solo point, this week (from Monday 00:00 UTC) or all time. Rows show the pilot's level. */
async function overall(me: string, day: "week" | "all", c?: string) {
  const lb = day === "all" ? ALL_TIME : weekBoard();
  const [top, mine] = await Promise.all([kv.ztop(lb, TOP), kv.zscore(lb, me)]);
  const ids = top.map(([id]) => id);
  const [names, myName, place, myAll] = await Promise.all([
    kv.mget<string>(ids.map(nickKey)), kv.get<string>(nickKey(me)), kv.zrank(lb, mine), day === "all" ? Promise.resolve(mine) : kv.zscore(ALL_TIME, me),
  ]);
  // levels come from all-time points; on the week board fetch those separately
  const allPts = day === "all" ? top.map(([, s]) => s) : await kv.zscores(ALL_TIME, ids);
  const rows = top.map(([id, score], i) => ({
    rank: 1 + top.findIndex(([, s]) => s === score), score, name: names[i] || fallbackName(id), grid: "",
    you: id === me, named: !!names[i], level: levelFor(allPts[i]).level,
  }));
  const inTop = ids.includes(me);
  const meRow = mine > 0 ? { rank: place.above + 1, score: mine, name: myName || fallbackName(me), named: !!myName, grid: "", inTop, level: levelFor(myAll).level } : null;
  return json({ date: day === "week" ? weekKey() : "all", day, players: place.total, rows, me: meRow, myName }, { cookie: c });
}
