import { CATEGORIES, createRun, dayNumber } from "@/lib/game";
import { body, clientIp, json, limited, playerFrom, sameOrigin } from "@/lib/security";

export const dynamic = "force-dynamic";

// Starts a run. Daily = today's shared prompts; endless = a brand-new AI-generated set every time.
export async function POST(req: Request) {
  if (!sameOrigin(req)) return json({ error: "bad-origin" }, { status: 403 });
  const p = playerFrom(req);
  const b = await body<{ mode?: string; category?: string }>(req);
  const mode = b?.mode === "endless" ? "endless" : "daily";
  const category = (CATEGORIES as readonly string[]).includes(b?.category ?? "") ? b!.category! : "anything";

  // Endless runs cost model tokens: cap them per player and per IP.
  if (mode === "endless" && ((await limited("run", p.id, 12, 3600)) || (await limited("run-ip", clientIp(req), 40, 3600))))
    return json({ error: "Too many new launches this hour. Try again soon." }, { status: 429, cookie: p.setCookie });

  const run = await createRun(mode, p.id, category);
  return json({
    runId: run.id, mode, date: run.date, dayNumber: dayNumber(run.date), category,
    prompts: run.prompts.map(({ id, text, category }) => ({ id, text, category })),
  }, { cookie: p.setCookie });
}
