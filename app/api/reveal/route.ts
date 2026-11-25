import { topAnswers, type Receipt } from "@/lib/game";
import { body, json, limited, playerFrom, verify } from "@/lib/security";

export const dynamic = "force-dynamic";

// "What did everyone else say?" — only for players holding a receipt for that prompt (no spoilers).
export async function POST(req: Request) {
  const p = playerFrom(req);
  if (await limited("reveal", p.id, 120, 3600)) return json({ error: "Slow down." }, { status: 429, cookie: p.setCookie });
  const b = await body<{ receipt?: string }>(req);
  const r = verify<Receipt>(b?.receipt);
  if (!r || r.player !== p.id) return json({ error: "Answer the prompt first." }, { status: 403, cookie: p.setCookie });
  return json(await topAnswers(r.prompt), { cookie: p.setCookie });
}
