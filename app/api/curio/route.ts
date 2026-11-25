import { curioFor, getRun, type Receipt } from "@/lib/game";
import { body, json, limited, playerFrom, verify } from "@/lib/security";

export const dynamic = "force-dynamic";

// "Did you know?" for an answer you just gave, plus where it sits on the survey. Needs your receipt (no spoilers).
export async function POST(req: Request) {
  const p = playerFrom(req), c = p.setCookie;
  if (await limited("curio", p.id, 150, 3600)) return json({ error: "Slow down." }, { status: 429, cookie: c });
  const r = verify<Receipt>((await body<{ receipt?: string }>(req))?.receipt);
  if (!r || r.player !== p.id || !r.answer) return json({ error: "Answer the prompt first." }, { status: 403, cookie: c });
  const run = await getRun(r.run);
  const prompt = run?.prompts[r.round];
  if (!prompt || prompt.id !== r.prompt) return json({ error: "Run not found." }, { status: 404, cookie: c });
  return json(await curioFor(prompt, r.answer), { cookie: c });
}
