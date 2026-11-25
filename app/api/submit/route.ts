import { after } from "next/server";
import { getRun, judge, MAX_TRIES, quipFor, recordAnswer, surveyFor, tierFor, type Receipt } from "@/lib/game";
import { getProfile, logAnswer, type AnswerLog } from "@/lib/profile";
import { body, clientIp, json, limited, playerFrom, sameOrigin, sign } from "@/lib/security";
import { cleanAnswer } from "@/lib/text";
import * as kv from "@/lib/store";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  if (!sameOrigin(req)) return json({ error: "bad-origin" }, { status: 403 });
  const p = playerFrom(req);
  const c = p.setCookie;
  const b = await body<{ runId?: string; round?: number; answer?: string; skip?: boolean }>(req);
  // independent lookups in parallel: each one is a network round trip
  const [overP, overIp, run] = await Promise.all([limited("submit", p.id, 60, 300), limited("submit-ip", clientIp(req), 200, 300), getRun(b?.runId)]);
  if (overP || overIp) return json({ error: "Slow down a little." }, { status: 429, cookie: c });
  const round = Number(b?.round);
  if (!run || run.player !== p.id) return json({ error: "Run not found. Start a new launch." }, { status: 404, cookie: c });
  if (!Number.isInteger(round) || round < 0 || round >= run.prompts.length) return json({ error: "bad-round" }, { status: 400, cookie: c });
  const [answered, hintUsed] = await Promise.all([kv.get(`answered:${run.id}:${round}`), kv.get(`hintused:${run.id}:${round}`)]);
  if (answered) return json({ error: "Already answered." }, { status: 409, cookie: c });

  const prompt = run.prompts[round];
  const upcoming = run.prompts[round + 1];
  if (upcoming) after(() => surveyFor(upcoming, 0).then(() => undefined)); // get the next prompt's survey ready
  const hint = Boolean(hintUsed) && hintUsed !== "boost"; // a boost is a free hint: full points
  // every attempt goes into the player's history; written after the response so it never slows the game down
  const log = (a: Omit<AnswerLog, "at" | "mode" | "run" | "round" | "prompt" | "promptId" | "category" | "hint">) =>
    after(() => logAnswer(p.id, { mode: run.mode, run: run.id, round, prompt: prompt.text, promptId: prompt.id, category: prompt.category, hint, ...a }).then(() => undefined));
  const issue = async (r: Omit<Receipt, "v" | "run" | "mode" | "date" | "player" | "round" | "prompt" | "at">) => {
    if (!(await kv.setNx(`answered:${run.id}:${round}`, 1, 2 * 86400))) return null;
    const receipt: Receipt = { v: 1, run: run.id, mode: run.mode, date: run.date, player: p.id, round, prompt: prompt.id, at: Date.now(), ...r };
    return sign(receipt);
  };

  if (b?.skip === true) {
    const receipt = await issue({ answer: null, tier: null, score: 0, hint });
    if (receipt) log({ typed: null, valid: false, skipped: true, score: 0, final: true });
    return receipt ? json({ accepted: false, final: true, score: 0, receipt }, { cookie: c }) : json({ error: "Already answered." }, { status: 409, cookie: c });
  }

  const answer = cleanAnswer(b?.answer);
  if (!answer) return json({ accepted: false, final: false, reason: "Type a real answer (60 characters max)." }, { cookie: c });

  let v;
  try { v = await judge(prompt, answer); }
  catch (e) {
    console.error("judge failed:", (e as Error).message);
    // nothing was used up: the player keeps all their tries and can press LAUNCH again
    return json({ error: "🛰️ The judge is catching its breath (lots of players right now). Try again in a few seconds. This didn't use a try." }, { status: 503, cookie: c });
  }

  if (!v.valid) {
    const tries = await kv.incr(`tries:${run.id}:${round}`, 2 * 86400);
    log({ typed: answer, valid: false, fail: v.fail ?? "made_up", reason: v.reason, final: tries >= MAX_TRIES, score: 0 });
    if (tries >= MAX_TRIES) {
      const receipt = await issue({ answer: null, tier: null, score: 0, hint });
      return json({ accepted: false, final: true, reason: v.reason || "Not on our star chart.", fail: v.fail ?? "made_up", score: 0, receipt }, { cookie: c });
    }
    return json({ accepted: false, final: false, reason: v.reason || "Not on our star chart.", fail: v.fail ?? "made_up", triesLeft: MAX_TRIES - tries }, { cookie: c });
  }

  // rarity = how often people in general give this answer (not how often players here did)
  const share = v.prior;
  const [, profile] = await Promise.all([recordAnswer(prompt, v.canonical, p.id), getProfile(p.id)]);
  const tier = tierFor(share);
  const score = hint ? Math.round(tier.score / 2) : tier.score;
  const receipt = await issue({ answer: v.canonical, tier: tier.key, score, hint, share: Math.round(share * 100) / 100 });
  if (!receipt) return json({ error: "Already answered." }, { status: 409, cookie: c });
  log({ typed: answer, valid: true, answer: v.canonical, tier: tier.key, share, score, final: true });
  // personal records, from the player's stored history
  // only worth a celebration when it's genuinely rare (Astronaut tier or better) and beats everything before it
  const rarestEver = profile.accepted > 0 && share < 3 && (!profile.rarest || share < profile.rarest.share);
  return json({
    accepted: true, final: true, answer: v.canonical, tier: tier.key, tierName: tier.name,
    score, hint, share: Math.round(share * 100) / 100, quip: quipFor(tier.key, v.canonical, share, v.quip), receipt,
    personal: { rarestEver, previousRarest: rarestEver ? profile.rarest : null, answered: profile.accepted + 1 },
  }, { cookie: c });
}
