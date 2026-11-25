import { dayKey } from "@/lib/game";
import { addBadges, addSights, ALL_TIME, answerCount, claimDaily, getProfile, importLegacy, recentAnswers, recentRuns, syncAllTime } from "@/lib/profile";
import { levelFor } from "@/lib/progress";
import * as kv from "@/lib/store";
import { body, json, limited, limitedLocal, playerFrom, sameOrigin } from "@/lib/security";

export const dynamic = "force-dynamic";

/** Everything stored about you: totals, recent runs and your recent answers. Only ever your own (cookie-bound). */
export async function GET(req: Request) {
  const p = playerFrom(req), c = p.setCookie;
  if (limitedLocal("profile", p.id, 60, 60)) return json({ error: "Slow down a little." }, { status: 429, cookie: c });
  await syncAllTime(p.id).catch(() => {});
  const [profile, runs, answers, answerTotal] = await Promise.all([getProfile(p.id), recentRuns(p.id, 30), recentAnswers(p.id, 60), answerCount(p.id)]);
  const today = dayKey();
  const place = profile.xp > 0 ? await kv.zrank(ALL_TIME, profile.xp).catch(() => null) : null;
  return json({
    profile, runs, answers, answerTotal, level: levelFor(profile.xp),
    bonusReady: profile.checkin.last !== today, allTimeRank: place ? place.above + 1 : null,
  }, { cookie: c });
}

/** Sync badges unlocked in the browser, and (once) import the stats this browser kept before they moved to the server. */
export async function POST(req: Request) {
  if (!sameOrigin(req)) return json({ error: "bad-origin" }, { status: 403 });
  const p = playerFrom(req), c = p.setCookie;
  if (await limited("profile-w", p.id, 60, 600)) return json({ error: "Slow down a little." }, { status: 429, cookie: c });
  const b = await body<{ badges?: Record<string, unknown>; legacy?: unknown; claim?: boolean; sights?: unknown }>(req, 8192);
  if (b?.sights) { const pr = await addSights(p.id, b.sights); return json({ ok: true, sights: pr.sights }, { cookie: c }); }
  if (b?.claim === true) return json(await claimDaily(p.id, dayKey()), { cookie: c });
  if (b?.legacy && typeof b.legacy === "object") await importLegacy(p.id, b.legacy);
  const profile = b?.badges && typeof b.badges === "object" ? await addBadges(p.id, b.badges) : await getProfile(p.id);
  return json({ ok: true, badges: profile.badges, legacy: Boolean(profile.legacy) }, { cookie: c });
}
