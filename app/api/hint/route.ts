import { getRun, hintFor } from "@/lib/game";
import { body, json, limited, playerFrom, sameOrigin } from "@/lib/security";
import * as kv from "@/lib/store";
import { spendBoost } from "@/lib/profile";

export const dynamic = "force-dynamic";

// A hint halves that round's score. Using it is recorded server-side, so it can't be hidden.
export async function POST(req: Request) {
  if (!sameOrigin(req)) return json({ error: "bad-origin" }, { status: 403 });
  const p = playerFrom(req);
  if (await limited("hint", p.id, 30, 3600)) return json({ error: "Too many hints." }, { status: 429, cookie: p.setCookie });
  const b = await body<{ runId?: string; round?: number; boost?: boolean }>(req);
  const run = await getRun(b?.runId);
  const round = Number(b?.round);
  if (!run || run.player !== p.id || !Number.isInteger(round) || !run.prompts[round])
    return json({ error: "Run not found." }, { status: 404, cookie: p.setCookie });
  if (await kv.get(`answered:${run.id}:${round}`)) return json({ error: "Already answered." }, { status: 409, cookie: p.setCookie });
  const prev = await kv.get(`hintused:${run.id}:${round}`);
  // a boost is a free hint: the round keeps full points. Spent once per round, never twice.
  let boosted = prev === "boost";
  if (!prev) {
    boosted = b?.boost === true && await spendBoost(p.id);
    if (b?.boost === true && !boosted) return json({ error: "No boosts left. Claim your daily bonus for more." }, { status: 409, cookie: p.setCookie });
    await kv.set(`hintused:${run.id}:${round}`, boosted ? "boost" : 1, 2 * 86400);
  }
  try { return json({ hint: await hintFor(run.prompts[round]), boosted }, { cookie: p.setCookie }); }
  catch { return json({ hint: "Skip the first three answers that come to mind.", boosted }, { cookie: p.setCookie }); }
}
