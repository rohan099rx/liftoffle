import { analysisFor, getRun, type Receipt } from "@/lib/game";
import { body, json, limited, playerFrom, sameOrigin, verify } from "@/lib/security";
import * as kv from "@/lib/store";

export const dynamic = "force-dynamic";

// A playful "pilot profile" of how you answered this run. Only for a finished run of your own (checked by receipts).
export async function POST(req: Request) {
  if (!sameOrigin(req)) return json({ error: "bad-origin" }, { status: 403 });
  const p = playerFrom(req), c = p.setCookie;
  if (await limited("analysis", p.id, 30, 3600)) return json({ error: "Slow down." }, { status: 429, cookie: c });
  const b = await body<{ runId?: string; receipts?: string[] }>(req, 8192);
  const run = await getRun(b?.runId);
  if (!run || run.player !== p.id || !(await kv.get(`done:${run.id}`))) return json({ error: "Finish the run first." }, { status: 404, cookie: c });
  const recs = (Array.isArray(b?.receipts) ? b!.receipts : []).map((t) => verify<Receipt>(t)).filter((r): r is Receipt => !!r && r.run === run.id && r.player === p.id);
  const byRound = new Map(recs.map((r) => [r.round, r]));
  const rounds = run.prompts.map((pr, i) => ({ prompt: pr.text, answer: byRound.get(i)?.answer ?? null, share: byRound.get(i)?.share ?? null }));
  return json(await analysisFor(run.id, rounds), { cookie: c });
}
