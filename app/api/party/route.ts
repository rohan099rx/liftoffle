import { chat, createRoom, endGameEarly, endRoundEarly, getRoom, kickPlayer, makeHost, joinRoom, leaveRoom, nextRound, PartyError, playAgain, prepPrompts, quietMs, react, roomChannel, startGame, submitAnswer, updateSettings, validCode, view } from "@/lib/party";
import { waitForPublish } from "@/lib/store";
import { body, clientIp, json, limited, limitedLocal, playerFrom, sameOrigin } from "@/lib/security";
import { cleanAnswer } from "@/lib/text";

export const dynamic = "force-dynamic";
export const maxDuration = 120; // a 60s round + grace while the judge retries in the background

/** How long one live-update request may wait for a change before answering "nothing new". */
const HOLD_MS = 20000;

const fail = (e: unknown, cookie?: string) => {
  if (e instanceof PartyError) return json({ error: e.message }, { status: e.status, cookie });
  console.error("party error:", (e as Error).message);
  return json({ error: "Mission control hiccuped. Try again." }, { status: 503, cookie });
};

// Live updates: GET /api/party?code=ABCD&v=12&wait=1 → answers the moment the room changes (or after
// ~20s with {same:true}). Without wait=1 it's a plain poll. The full view only goes out when v changed.
export async function GET(req: Request) {
  const p = playerFrom(req);
  const url = new URL(req.url), code = url.searchParams.get("code")?.toUpperCase();
  if (!validCode(code)) return json({ error: "Bad room code." }, { status: 400, cookie: p.setCookie });
  try {
    // polls are the hottest path: rate-limit in memory so each poll is a single database read
    if (limitedLocal("poll", p.id, 600, 300)) return json({ error: "Slow down a little." }, { status: 429, cookie: p.setCookie });
    const have = Number(url.searchParams.get("v"));
    let room = await getRoom(code);
    if (url.searchParams.get("wait") === "1" && have === room.v) {
      const ms = Math.min(HOLD_MS, quietMs(room));
      // Stream the reply: a space every 2.5s while we wait (JSON ignores leading spaces), then the JSON.
      // The browser treats a few seconds of silence as a dead connection and reconnects straight away,
      // instead of waiting out the whole hold on a phone that silently lost signal.
      const ac = new AbortController(), enc = new TextEncoder();
      const stream = new ReadableStream<Uint8Array>({
        async start(ctrl) {
          ctrl.enqueue(enc.encode(" ")); // first byte now, so the browser knows the connection is alive
          const beat = setInterval(() => { try { ctrl.enqueue(enc.encode(" ")); } catch {} }, 2500);
          let out: unknown;
          try {
            // subscribe first, then re-check, so a change landing in between is never missed
            const why = await waitForPublish(roomChannel(code), ms, async () => { room = await getRoom(code); return room.v !== have; }, AbortSignal.any([req.signal, ac.signal]));
            if (why !== "ready") room = await getRoom(code);
            out = have === room.v ? { same: true, now: Date.now() } : view(room, p.id);
          } catch (e) {
            out = e instanceof PartyError ? { error: e.message, status: e.status } : { error: "Mission control hiccuped. Try again.", status: 503 };
          } finally { clearInterval(beat); }
          try { ctrl.enqueue(enc.encode(JSON.stringify(out))); ctrl.close(); } catch {}
        },
        cancel() { ac.abort(); },
      });
      const headers = new Headers({ "Content-Type": "application/json", "Cache-Control": "no-store", "X-Accel-Buffering": "no" });
      if (p.setCookie) headers.append("Set-Cookie", p.setCookie);
      return new Response(stream, { headers });
    }
    if (have === room.v) return json({ same: true, now: Date.now() }, { cookie: p.setCookie });
    return json(view(room, p.id), { cookie: p.setCookie });
  } catch (e) { return fail(e, p.setCookie); }
}

export async function POST(req: Request) {
  if (!sameOrigin(req)) return json({ error: "bad-origin" }, { status: 403 });
  const p = playerFrom(req), c = p.setCookie;
  const b = await body<any>(req);
  const action = String(b?.action ?? "");
  const code = typeof b?.code === "string" ? b.code.toUpperCase() : "";
  if (action !== "create" && !validCode(code)) return json({ error: "Bad room code." }, { status: 400, cookie: c });
  const [overP, overIp] = await Promise.all([limited("party", p.id, 240, 300), limited("party-ip", clientIp(req), 800, 300)]);
  if (overP || overIp)
    return json({ error: "Slow down a little." }, { status: 429, cookie: c });

  try {
    switch (action) {
      case "create": {
        if ((await limited("party-create", p.id, 20, 3600)) || (await limited("party-create-ip", clientIp(req), 200, 3600)))
          return json({ error: "Too many rooms this hour. Try again soon." }, { status: 429, cookie: c });
        const room = await createRoom(p.id, b.name, b.avatar, b.settings);
        prepPrompts(room.code, room.settings, room.used);
        return json(view(room, p.id), { cookie: c });
      }
      case "join": return json(view(await joinRoom(code, p.id, b.name, b.avatar), p.id), { cookie: c });
      case "leave": await leaveRoom(code, p.id); return json({ ok: true }, { cookie: c });
      case "settings": { const room = await updateSettings(code, p.id, b.settings); prepPrompts(code, room.settings, room.used); return json(view(room, p.id), { cookie: c }); }
      case "start": {
        if (await limited("party-start", p.id, 20, 3600)) return json({ error: "Too many games this hour. Try again soon." }, { status: 429, cookie: c });
        return json(view(await startGame(code, p.id), p.id), { cookie: c });
      }
      case "answer": {
        if (await limited("party-answer", p.id, 60, 300)) return json({ error: "Slow down a little." }, { status: 429, cookie: c });
        const skip = b.skip === true;
        const answer = skip ? null : cleanAnswer(b.answer);
        if (!skip && !answer) return json({ feedback: { ok: false, final: false, reason: "Type a real answer (60 characters max)." } }, { cookie: c });
        const { room, feedback } = await submitAnswer(code, p.id, answer);
        return json({ ...view(room, p.id), feedback }, { cookie: c });
      }
      case "next": return json(view(await nextRound(code, p.id), p.id), { cookie: c });
      case "again": { const room = await playAgain(code, p.id); prepPrompts(code, room.settings, room.used); return json(view(room, p.id), { cookie: c }); }
      case "react": {
        if (await limited("party-react", p.id, 30, 30)) return json({ error: "Easy on the emojis!" }, { status: 429, cookie: c });
        return json(view(await react(code, p.id, b.emoji), p.id), { cookie: c });
      }
      case "chat": {
        if (await limited("party-chat", p.id, 12, 20)) return json({ error: "You're typing fast! Wait a moment." }, { status: 429, cookie: c });
        return json(view(await chat(code, p.id, b.text), p.id), { cookie: c });
      }
      case "kick": return json(view(await kickPlayer(code, p.id, b.pid), p.id), { cookie: c });
      case "host": return json(view(await makeHost(code, p.id, b.pid), p.id), { cookie: c });
      case "end-round": return json(view(await endRoundEarly(code, p.id), p.id), { cookie: c });
      case "end-game": return json(view(await endGameEarly(code, p.id), p.id), { cookie: c });
      default: return json({ error: "Unknown action." }, { status: 400, cookie: c });
    }
  } catch (e) { return fail(e, c); }
}
