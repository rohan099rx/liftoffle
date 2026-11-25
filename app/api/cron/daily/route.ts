import { timingSafeEqual } from "node:crypto";
import { dailyPrompts, dayKey, warmSurveys } from "@/lib/game";
import { clientIp, limited } from "@/lib/security";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

// Vercel Cron (see vercel.json) calls this at 23:30 UTC to write TOMORROW's daily prompts and their
// rarity surveys ahead of time, so the first players after midnight never wait on the AI.
// It is safe to leave open: it can only prepare tomorrow's set, and once that exists every further
// call is a cache hit. If CRON_SECRET is set (Vercel then sends it automatically), it is required.
export async function GET(req: Request) {
  const secret = process.env.CRON_SECRET;
  if (secret) {
    const got = Buffer.from(req.headers.get("authorization") || "");
    const want = Buffer.from(`Bearer ${secret}`);
    if (got.length !== want.length || !timingSafeEqual(got, want)) return new Response("unauthorized", { status: 401 });
  } else if (await limited("cron", clientIp(req), 3, 3600)) {
    return new Response("too many requests", { status: 429 });
  }

  const tomorrow = dayKey(Date.now() + 86400_000);
  const prompts = await dailyPrompts(tomorrow);
  await warmSurveys(prompts, prompts.length); // the cron has minutes to spare, so do all of them
  return Response.json({ date: tomorrow, prompts: prompts.length });
}
