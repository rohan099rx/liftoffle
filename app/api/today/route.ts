import { after } from "next/server";
import { dailyPrompts, dayKey, dayNumber, resetsAt } from "@/lib/game";
import { mockMode } from "@/lib/groq";

export const dynamic = "force-dynamic";

// Answers instantly: the page only needs the date and countdown. Today's prompts are made (if they
// aren't already) in the background, so the first visitor of the day never stares at a frozen menu.
export async function GET() {
  const date = dayKey();
  after(() => dailyPrompts(date).then(() => undefined).catch(() => undefined));
  return new Response(JSON.stringify({ date, dayNumber: dayNumber(date), resetsAt: resetsAt(), mock: mockMode }), {
    headers: { "Content-Type": "application/json", "Cache-Control": "public, max-age=30, s-maxage=60" },
  });
}
