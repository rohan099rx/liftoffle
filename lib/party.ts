import "server-only";
import { randomInt } from "node:crypto";
import { after } from "next/server";
import { CATEGORIES, freshPrompts, judge, JudgeBusy, MAX_TRIES, quipFor, recordAnswer, surveyFor, tierFor, warmSurveys, type Prompt } from "./game";
import { logAnswer } from "./profile";
import { key } from "./text";
import * as kv from "./store";

// ------------------------------------------------------------------ config
const ROOM_TTL = 6 * 3600;
export const MAX_PLAYERS = 12;
const ONLY_YOU_BONUS = 30;   // nobody else in the room said it
const SPEED_MAX = 20;        // answer instantly → +20, at the buzzer → +0
const GET_READY_MS = 3500;   // countdown before each prompt
const REVEAL_TAKEOVER_MS = 25000; // anyone can press NEXT if the host goes quiet
// Sudden Death: after the last round the top two face one extra prompt. One try, short timer, double rarity points.
const SD_SECONDS = 10, SD_READY_MS = 6000, SD_MULT = 2;
// Room DNA: what each player has said in front of their friends is remembered; repeating yourself costs you.
const REPEAT_PENALTY = 10, DNA_TTL = 90 * 86400, DNA_MAX_SEEN = 500;
export const AVATARS = ["🚀", "🛸", "👽", "🌟", "🪐", "☄️", "🐱", "🦊", "🐼", "🐸", "🦄", "🤖", "🐙", "🦖", "🍕", "👾"];
export const REACTIONS = ["🔥", "😂", "🤯", "👏", "🚀", "😱"];
const CODE_CHARS = "ABCDEFGHJKMNPQRSTUVWXYZ";

// ------------------------------------------------------------------ types
type Player = { pid: string; uid: string; name: string; avatar: string; score: number; joined: number };
// `pending` = locked in, being judged in the background. `rejected` = why the last try was refused.
type Answer = { answer: string | null; key: string | null; share: number; tier: string | null; quip: string; tries: number; final: boolean; at: number;
  pending?: string | null; rejected?: string | null; unverified?: boolean;
  fails?: Blooper[]; failKind?: string | null };
/** A rejected attempt, kept for the blooper reel. */
type Blooper = { text: string; why: string; kind: string };
const JUDGE_GRACE_MS = 10000; // how long results wait past the timer for answers still being judged
export type ResultRow = { pid: string; answer: string | null; tier: string | null; base: number; jinx: number; only: number; speed: number; points: number; quip: string; unverified?: boolean; fails?: Blooper[]; repeat?: number };
export type Trait = { id: string; name: string; e: string; pct: number };
type Room = {
  code: string; v: number; created: number; host: string;
  phase: "lobby" | "starting" | "answer" | "reveal" | "final";
  settings: { category: string; rounds: number; seconds: number; sudden: boolean; dna: boolean };
  players: Player[]; nextPid: number;
  prompts: Prompt[]; used: string[]; round: number; startingAt: number; startsAt: number; deadline: number; revealAt: number;
  answers: Record<string, Answer>;
  results: { prompt: string; rows: ResultRow[]; sd?: boolean }[];
  sdPrompt?: Prompt | null;                                   // the extra prompt kept for the final
  sd?: { finalists: string[]; done: boolean; winner: string | null } | null;
  gameNo?: number;
  dnaSeen?: Record<string, string[]>;                         // pid -> answers they've already said in front of this crew
  dna?: Record<string, { traits: Trait[]; answers: number; games: number; repeats: number }> | null; // shown on the podium
  reactions: { id: number; pid: string; e: string; at: number }[]; nextReaction: number;
  chat?: ChatMsg[]; nextChat?: number;
  kicked?: string[]; // uids the host removed: they can't rejoin this room
  events?: RoomEvent[]; nextEvent?: number; // "Sam joined", "Ana is now host"… shown as toasts
};
type ChatMsg = { id: number; pid: string; name: string; avatar: string; text: string; at: number };
type RoomEvent = { id: number; text: string; at: number; pid?: string };
const CHAT_MAX = 40;
function note(room: Room, text: string, pid?: string) {
  const now = Date.now();
  room.nextEvent = (room.nextEvent ?? 1);
  room.events = [...(room.events ?? []).filter((e) => now - e.at < 15000), { id: room.nextEvent++, text, at: now, pid }].slice(-12);
}

export class PartyError extends Error { constructor(msg: string, public status = 400) { super(msg); } }

const rk = (code: string) => `party:${code}`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
export const validCode = (c: unknown): c is string => typeof c === "string" && /^[A-Z]{4}$/.test(c);

function cleanName(raw: unknown): string {
  const s = typeof raw === "string" ? raw.normalize("NFKC").replace(/[^\p{L}\p{N} _.'-]/gu, "").replace(/\s+/g, " ").trim().slice(0, 16) : "";
  if (!s) throw new PartyError("Pick a nickname first.");
  return s;
}
const cleanAvatar = (a: unknown) => (typeof a === "string" && AVATARS.includes(a) ? a : AVATARS[0]);
function cleanSettings(s: any) {
  return {
    category: (CATEGORIES as readonly string[]).includes(s?.category) ? s.category : "anything",
    rounds: [5, 7, 10].includes(Number(s?.rounds)) ? Number(s.rounds) : 7,
    seconds: [20, 30, 45, 60].includes(Number(s?.seconds)) ? Number(s.seconds) : 30,
    sudden: s?.sudden !== false,
    dna: s?.dna !== false,
  };
}

// ------------------------------------------------------------------ storage with a short lock
async function load(code: string): Promise<Room> {
  const room = await kv.get<Room>(rk(code));
  if (!room) throw new PartyError("Room not found. Check the code, or it may have expired.", 404);
  return room;
}

export const roomChannel = (code: string) => `party:${code}`;

/** How long a waiting poll may sleep before the room changes on its own (timer ends, stuck start). */
export function quietMs(room: Room, now = Date.now()): number {
  if (room.phase === "answer") {
    const end = room.deadline + 1600 - now;
    if (end > 0) return end;
    return Math.max(300, room.deadline + JUDGE_GRACE_MS + 100 - now);
  }
  if (room.phase === "starting") return Math.max(300, room.startingAt + 60100 - now);
  return Infinity;
}

/** Read-modify-write under a per-room lock so simultaneous answers don't overwrite each other. */
async function mutate(code: string, fn: (room: Room) => void): Promise<Room> {
  const lock = `lock:${rk(code)}`;
  for (let i = 0; i < 60; i++) {
    if (await kv.setNx(lock, 1, 5)) {
      try {
        const room = await load(code);
        fn(room);
        room.v++;
        // save + unlock + wake every waiting player, in one database round trip
        await kv.commit(rk(code), room, ROOM_TTL, lock, roomChannel(code), String(room.v));
        return room;
      } catch (e) { await kv.del(lock).catch(() => {}); throw e; }
    }
    await sleep(25 + Math.random() * 35);
  }
  throw new PartyError("The room is busy. Try again.", 503);
}

const me = (room: Room, uid: string) => room.players.find((p) => p.uid === uid);
function mustBeIn(room: Room, uid: string) { const p = me(room, uid); if (!p) throw new PartyError("You're not in this room. Join it first.", 403); return p; }
function mustHost(room: Room, uid: string) { const p = mustBeIn(room, uid); if (p.pid !== room.host) throw new PartyError("Only the host can do that.", 403); return p; }

// ------------------------------------------------------------------ scoring
function finalizeRound(room: Room) {
  if (room.phase !== "answer") return;
  for (const p of room.players) {
    const a = room.answers[p.pid];
    if (a?.pending && !a.key) {
      // the judge never got to it: it doesn't count (unchecked answers are never accepted)
      room.answers[p.pid] = { ...a, final: true, pending: null, rejected: `“${a.pending}”: the judge didn't get to it in time.`, failKind: "busy" };
    }
  }
  const sd = room.sd && !room.sd.done ? room.sd : null;
  const playing = sd ? room.players.filter((p) => sd.finalists.includes(p.pid)) : room.players;
  const valid = playing.map((p) => ({ p, a: room.answers[p.pid] })).filter((x) => x.a?.key);
  const groups = new Map<string, number>();
  for (const { a } of valid) groups.set(a.key!, (groups.get(a.key!) ?? 0) + 1);
  const window = Math.max(1, room.deadline - room.startsAt);
  const rows: ResultRow[] = playing.map((p) => {
    const a = room.answers[p.pid];
    const fails = a?.fails?.length ? a.fails : undefined;
    if (!a?.key) return { pid: p.pid, answer: null, tier: null, base: 0, jinx: 0, only: 0, speed: 0, points: 0,
      quip: a?.failKind === "busy" ? "🛰️ The judge was too busy to check this one. No points, sorry!" : a?.fails?.length ? "Crashed on the pad." : a ? "Chickened out. 🐔" : "Never left the pad.", fails };
    const t = tierFor(a.share), k = groups.get(a.key)!;
    const base = Math.round((t.score * (sd ? SD_MULT : 1)) / k);
    // Room DNA: said this before in front of someone here? No uniqueness bonus, and a small penalty
    const repeat = room.settings.dna && room.dnaSeen?.[p.pid]?.includes(a.key) ? REPEAT_PENALTY : 0;
    const only = k === 1 && valid.length >= 2 && !sd && !repeat ? ONLY_YOU_BONUS : 0;
    const speed = Math.round(SPEED_MAX * Math.min(1, Math.max(0, (room.deadline - a.at) / window)));
    return { pid: p.pid, answer: a.answer, tier: t.key, base, jinx: k > 1 ? k : 0, only, speed, points: Math.max(0, base + only + speed - repeat), quip: a.quip, unverified: a.unverified || undefined, fails, ...(repeat ? { repeat } : {}) };
  });
  for (const r of rows) { const p = room.players.find((x) => x.pid === r.pid); if (p) p.score += r.points; }
  // what you say now counts as "said before" for the rest of the game, too
  if (room.settings.dna) {
    room.dnaSeen ??= {};
    for (const { p, a } of valid) room.dnaSeen[p.pid] = [...new Set([...(room.dnaSeen[p.pid] ?? []), a.key!])].slice(-DNA_MAX_SEEN);
  }
  room.results.push({ prompt: room.prompts[room.round].text, rows, ...(sd ? { sd: true } : {}) });
  if (sd) {
    // more points this round wins; a tie goes to whoever leads overall after it; a full tie is a draw
    const [a, b] = [...rows].sort((x, y) => y.points - x.points || (room.players.find((p) => p.pid === y.pid)?.score ?? 0) - (room.players.find((p) => p.pid === x.pid)?.score ?? 0));
    const score = (r?: ResultRow) => room.players.find((p) => p.pid === r?.pid)?.score ?? 0;
    sd.winner = a && (!b || a.points > b.points || score(a) > score(b)) ? a.pid : null;
    sd.done = true;
  }
  room.phase = "reveal"; room.revealAt = Date.now();
}

const answering = (room: Room) => (room.sd && !room.sd.done ? room.players.filter((p) => room.sd!.finalists.includes(p.pid)) : room.players);
const allDone = (room: Room) => { const ps = answering(room); return ps.length > 0 && ps.every((p) => room.answers[p.pid]?.final); };

// ------------------------------------------------------------------ actions
export async function createRoom(uid: string, name: unknown, avatar: unknown, settings: unknown): Promise<Room> {
  const n = cleanName(name);
  for (let i = 0; i < 20; i++) {
    const code = Array.from({ length: 4 }, () => CODE_CHARS[randomInt(CODE_CHARS.length)]).join("");
    const room: Room = {
      code, v: 1, created: Date.now(), host: "p1", phase: "lobby", settings: cleanSettings(settings),
      players: [{ pid: "p1", uid, name: n, avatar: cleanAvatar(avatar), score: 0, joined: Date.now() }], nextPid: 2,
      prompts: [], used: [], round: 0, startingAt: 0, startsAt: 0, deadline: 0, revealAt: 0, answers: {}, results: [], reactions: [], nextReaction: 1,
    };
    if (await kv.setNx(rk(code), room, ROOM_TTL)) return room;
  }
  throw new PartyError("Couldn't find a free room code. Try again.", 503);
}

export const joinRoom = (code: string, uid: string, name: unknown, avatar: unknown) => {
  const n = cleanName(name), av = cleanAvatar(avatar);
  return mutate(code, (room) => {
    const existing = me(room, uid);
    if (existing) { existing.name = n; existing.avatar = av; return; }
    if (room.kicked?.includes(uid)) throw new PartyError("The host removed you from this room.", 403);
    if (room.players.length >= MAX_PLAYERS) throw new PartyError(`This room is full (${MAX_PLAYERS} players).`, 409);
    if (room.players.some((p) => p.name.toLowerCase() === n.toLowerCase())) throw new PartyError("Someone in the room already has that name.", 409);
    room.players.push({ pid: `p${room.nextPid++}`, uid, name: n, avatar: av, score: 0, joined: Date.now() });
    note(room, `${av} ${n} joined`, room.players[room.players.length - 1].pid);
  });
};

export const leaveRoom = (code: string, uid: string) => mutate(code, (room) => {
  const p = me(room, uid); if (!p) return;
  removePlayer(room, p, `${p.avatar} ${p.name} left`);
});

function removePlayer(room: Room, p: Player, why: string) {
  room.players = room.players.filter((x) => x !== p);
  delete room.answers[p.pid];
  note(room, why);
  if (room.host === p.pid && room.players[0]) { room.host = room.players[0].pid; note(room, `${room.players[0].avatar} ${room.players[0].name} is now the host`); }
  if (room.phase === "answer" && allDone(room)) finalizeRound(room);
}

// ---- host controls
export const kickPlayer = (code: string, uid: string, pid: unknown) => mutate(code, (room) => {
  const host = mustHost(room, uid);
  const p = room.players.find((x) => x.pid === pid);
  if (!p) throw new PartyError("That player already left.", 409);
  if (p === host) throw new PartyError("You can't remove yourself. Use LEAVE.");
  room.kicked = [...(room.kicked ?? []), p.uid].slice(-50);
  removePlayer(room, p, `${p.avatar} ${p.name} was removed by the host`);
});
export const makeHost = (code: string, uid: string, pid: unknown) => mutate(code, (room) => {
  mustHost(room, uid);
  const p = room.players.find((x) => x.pid === pid);
  if (!p) throw new PartyError("That player already left.", 409);
  room.host = p.pid; note(room, `${p.avatar} ${p.name} is now the host`);
});
/** End the answering phase now. Answers still being judged get the usual grace period. */
export const endRoundEarly = (code: string, uid: string) => mutate(code, (room) => {
  mustHost(room, uid);
  if (room.phase !== "answer") throw new PartyError("No round is running.", 409);
  const now = Date.now();
  if (now < room.startsAt) throw new PartyError("Let the countdown finish first.", 409);
  room.deadline = Math.min(room.deadline, now - 1600); // results appear as soon as pending answers land
  note(room, "⏱️ The host ended the round");
  if (!Object.values(room.answers).some((a) => a.pending)) finalizeRound(room);
});
export async function endGameEarly(code: string, uid: string) {
  const room = await mutate(code, (room) => {
    mustHost(room, uid);
    if (room.phase !== "reveal" && room.phase !== "answer") throw new PartyError("No game is running.", 409);
    if (room.phase === "answer") finalizeRound(room);
    room.phase = "final"; note(room, "🏁 The host ended the game");
  });
  after(() => saveDna(code));
  return room;
}

export const chat = (code: string, uid: string, raw: unknown) => mutate(code, (room) => {
  const p = mustBeIn(room, uid);
  const text = typeof raw === "string" ? raw.normalize("NFKC").replace(/[\u0000-\u001f\u007f]/g, "").replace(/\s+/g, " ").trim().slice(0, 120) : "";
  if (!text) throw new PartyError("Type a message first.");
  // don't spoil the round: block chat that contains the answer you locked in
  const mine = room.phase === "answer" ? room.answers[p.pid] : undefined;
  const locked = (mine?.pending ?? mine?.answer ?? "").toLowerCase();
  if (locked && locked.length > 2 && text.toLowerCase().includes(locked)) throw new PartyError("No spoilers! Wait for the results.");
  room.nextChat = room.nextChat ?? 1;
  room.chat = [...(room.chat ?? []), { id: room.nextChat++, pid: p.pid, name: p.name, avatar: p.avatar, text, at: Date.now() }].slice(-CHAT_MAX);
});

export const updateSettings = (code: string, uid: string, settings: unknown) => mutate(code, (room) => {
  mustHost(room, uid);
  if (room.phase !== "lobby") throw new PartyError("Settings can only change in the lobby.");
  room.settings = cleanSettings(settings);
});

const prepKey = (code: string, category: string) => `prep:${rk(code)}:${category}`;
/** Write the next game's questions ahead of time so START is instant. Once per room + category. */
export function prepPrompts(code: string, settings: Room["settings"], used: string[]) {
  after(async () => {
    try {
      const k = prepKey(code, settings.category);
      if (!(await kv.setNx(`${k}:busy`, 1, 120))) return;
      if (await kv.get(k)) return;
      const all: Prompt[] = [];
      while (all.length < settings.rounds + (settings.sudden ? 1 : 0)) {
        const batch = await freshPrompts(settings.category, [...used, ...all.map((p) => p.text)], `prep-${code}-${Date.now()}-${all.length}`, settings.rounds + 1 - all.length);
        const fresh = batch.filter((p) => !all.some((q) => q.id === p.id));
        if (!fresh.length) break;
        all.push(...fresh);
      }
      await kv.set(k, all, 3600);
    } catch (e) { console.error("prompt prep failed:", (e as Error).message); }
  });
}

export async function startGame(code: string, uid: string): Promise<Room> {
  const r = await mutate(code, (room) => {
    mustHost(room, uid);
    if (room.phase !== "lobby") throw new PartyError("The game has already started.", 409);
    room.phase = "starting"; room.startingAt = Date.now();
  });
  let prompts: Prompt[];
  try {
    // questions written in the background while everyone sat in the lobby
    const prep = await kv.get<Prompt[]>(prepKey(code, r.settings.category)).catch(() => null);
    const want = r.settings.rounds + (r.settings.sudden ? 1 : 0); // +1 kept back for the Sudden Death final
    const all: Prompt[] = (prep ?? []).filter((p) => !r.used.includes(p.text)).slice(0, want);
    if (prep) void kv.del(prepKey(code, r.settings.category)).catch(() => {});
    // generatePrompts returns 7 at a time; ask again for 10-round games
    while (all.length < want) {
      const batch = await freshPrompts(r.settings.category, [...r.used, ...all.map((p) => p.text)], `party-${code}-${Date.now()}-${all.length}`, want - all.length);
      const fresh = batch.filter((p) => !all.some((q) => q.id === p.id));
      if (!fresh.length) break;
      all.push(...fresh);
    }
    prompts = all.slice(0, want);
    after(() => warmSurveys(prompts)); // build the rarity surveys while players read the first prompt
  } catch (e) {
    await mutate(code, (room) => { room.phase = "lobby"; });
    throw e;
  }
  // Room DNA: for each player, the answers they've already given in front of anyone who's in this room now
  const seen: Record<string, string[]> = {};
  if (r.settings.dna) {
    const docs = await kv.mget<Dna>(r.players.map((p) => dnaKey(p.uid))).catch(() => [] as (Dna | null)[]);
    r.players.forEach((p, i) => {
      const others = new Set(r.players.filter((q) => q.uid !== p.uid).map((q) => q.uid));
      seen[p.pid] = Object.entries(docs[i]?.seen ?? {}).filter(([, v]) => v.w.some((u) => others.has(u))).map(([k]) => k);
    });
  }
  return mutate(code, (room) => {
    room.dnaSeen = room.settings.dna ? seen : {}; room.dna = null; room.gameNo = (room.gameNo ?? 0) + 1;
    const normal = room.settings.sudden && prompts.length > 1 ? prompts.length - 1 : prompts.length;
    room.sdPrompt = room.settings.sudden && prompts.length > normal ? prompts[normal] : null;
    room.prompts = prompts.slice(0, normal); room.used = [...room.used, ...prompts.map((p) => p.text)].slice(-80);
    room.settings.rounds = normal;
    room.round = 0; room.results = []; room.answers = {}; room.sd = null;
    for (const p of room.players) p.score = 0;
    room.startsAt = Date.now() + GET_READY_MS; room.deadline = room.startsAt + room.settings.seconds * 1000;
    room.phase = "answer";
  });
}

export async function submitAnswer(code: string, uid: string, raw: string | null): Promise<{ room: Room; feedback: { ok: boolean; final: boolean; pending?: boolean; reason?: string; triesLeft?: number } }> {
  const lockedAt = Date.now();
  let round = -1, pid = "";
  const room = await mutate(code, (room) => {
    const player = mustBeIn(room, uid);
    if (room.phase !== "answer") throw new PartyError("This round is over.", 409);
    if (lockedAt < room.startsAt - 500) throw new PartyError("Wait for the countdown!", 409);
    if (lockedAt > room.deadline + 1500) throw new PartyError("Time's up!", 409);
    const prev = room.answers[player.pid] ?? { answer: null, key: null, share: 0, tier: null, quip: "", tries: 0, final: false, at: 0 };
    if (room.sd && !room.sd.done && !room.sd.finalists.includes(player.pid)) throw new PartyError("Only the two finalists answer in Sudden Death. Enjoy the show!", 409);
    if (prev.final) throw new PartyError("You've already locked in.", 409);
    if (prev.pending) throw new PartyError("Still checking your last answer…", 409);
    round = room.round; pid = player.pid;
    room.answers[player.pid] = raw === null
      ? { ...prev, final: true, pending: null, rejected: null, at: lockedAt }
      : { ...prev, pending: raw, rejected: null, at: Math.min(lockedAt, room.deadline) };
    if (allDone(room)) finalizeRound(room);
  });
  // Lock-in is instant; the AI judge runs after the response is sent and the room updates when it's done.
  if (raw !== null) after(() => resolveAnswer(code, round, pid, uid, raw));
  else { const pr = room.prompts[round]; if (pr) after(() => logAnswer(uid, { mode: "party", run: `party:${code}`, round, prompt: pr.text, promptId: pr.id, category: pr.category, typed: null, valid: false, skipped: true, final: true }).then(() => undefined)); }
  return { room, feedback: raw === null ? { ok: false, final: true } : { ok: true, final: false, pending: true } };
}

async function resolveAnswer(code: string, round: number, pid: string, uid: string, raw: string) {
  const pre = await kv.get<Room>(rk(code));
  const prompt = pre?.prompts[round];
  if (!pre || !prompt) return;
  let verdict;
  for (;;) {
    // keep asking the real judge; only in the last seconds before results is "on trust" allowed
    const lastChance = Date.now() > pre.deadline + JUDGE_GRACE_MS - 6500; // wide enough that the 2.5s retry loop always gets one try in it
    try { verdict = await judge(prompt, raw, { trust: lastChance }); break; }
    catch (e) {
      if (!(e instanceof JudgeBusy)) { console.error("judge error:", (e as Error).message); }
      // AI busy: keep trying until the results are due. Whatever is still unchecked then scores nothing.
      const room = await kv.get<Room>(rk(code)).catch(() => null);
      if (!room || room.phase !== "answer" || room.round !== round || Date.now() > room.deadline + JUDGE_GRACE_MS - 3000) return;
      await sleep(2500);
    }
  }
  if (verdict.valid && !verdict.unverified) await recordAnswer(prompt, verdict.canonical, uid);
  const v = verdict, tk = tierFor(v.prior).key;
  after(() => logAnswer(uid, { mode: "party", run: `party:${code}`, round, prompt: prompt.text, promptId: prompt.id, category: prompt.category,
    typed: raw, valid: v.valid, answer: v.valid ? v.canonical : undefined, tier: v.valid ? tk : undefined, share: v.valid ? v.prior : undefined,
    fail: v.valid ? undefined : v.fail ?? "made_up", reason: v.valid ? undefined : v.reason }).then(() => undefined));
  await mutate(code, (room) => {
    const a = room.answers[pid];
    if (room.phase !== "answer" || room.round !== round || !a || a.pending !== raw) return; // round moved on, or superseded
    if (verdict.valid) {
      room.answers[pid] = { ...a, answer: verdict.canonical, key: key(verdict.canonical), share: verdict.prior, tier: tk,
        quip: quipFor(tk, verdict.canonical, verdict.prior, verdict.quip), tries: a.tries + 1, final: true, pending: null, rejected: null, unverified: verdict.unverified };
    } else {
      const tries = a.tries + 1;
      // out of tries, or the timer already ran out while we were judging: no more retries
      const final = tries >= (room.sd && !room.sd.done ? 1 : MAX_TRIES) || Date.now() > room.deadline; // Sudden Death: one shot
      const why = verdict.reason || "Not on our star chart.";
      room.answers[pid] = { ...a, tries, final, pending: null, rejected: `“${raw}”: ${why}`, failKind: verdict.fail ?? "made_up",
        fails: [...(a.fails ?? []), { text: raw.slice(0, 60), why, kind: verdict.fail ?? "made_up" }] };
      const p = room.players.find((x) => x.pid === pid);
      if (p) note(room, `😬 ${p.name} just crashed${final ? " and is out of fuel" : ""}!`, pid); // no spoilers: the answer stays hidden
    }
    if (allDone(room)) finalizeRound(room);
  }).catch((e) => console.error("resolveAnswer:", (e as Error).message));
}

export async function nextRound(code: string, uid: string): Promise<Room> {
  const room = await advance(code, uid);
  if (room.phase === "final") after(() => saveDna(code));
  const upcoming = room.phase === "answer" ? room.prompts[room.round + 1] : undefined;
  if (upcoming) after(() => surveyFor(upcoming, 0).then(() => undefined)); // get the next prompt's survey ready
  return room;
}

const advance = (code: string, uid: string) => mutate(code, (room) => {
  const p = mustBeIn(room, uid);
  if (room.phase !== "reveal") throw new PartyError("Not ready for the next round yet.", 409);
  if (p.pid !== room.host && Date.now() - room.revealAt < REVEAL_TAKEOVER_MS) throw new PartyError("Waiting for the host to continue.", 403);
  if (room.round + 1 >= room.prompts.length) {
    // the last round is over: the top two go to Sudden Death (once per game, needs 2+ players who scored)
    const ranked = [...room.players].sort((a, b) => b.score - a.score || a.joined - b.joined);
    if (!room.sd && room.settings.sudden && room.sdPrompt && ranked.length >= 2 && ranked[1].score > 0) {
      room.sd = { finalists: [ranked[0].pid, ranked[1].pid], done: false, winner: null };
      room.prompts.push(room.sdPrompt); room.sdPrompt = null;
      room.round++; room.answers = {};
      room.startsAt = Date.now() + SD_READY_MS; room.deadline = room.startsAt + SD_SECONDS * 1000;
      room.phase = "answer";
      note(room, `⚔️ SUDDEN DEATH: ${ranked[0].avatar} ${ranked[0].name} vs ${ranked[1].avatar} ${ranked[1].name}`);
      return;
    }
    room.phase = "final"; return;
  }
  room.round++; room.answers = {};
  room.startsAt = Date.now() + GET_READY_MS; room.deadline = room.startsAt + room.settings.seconds * 1000;
  room.phase = "answer";
});

export const playAgain = (code: string, uid: string) => mutate(code, (room) => {
  mustHost(room, uid);
  if (room.phase !== "final") throw new PartyError("Finish this game first.", 409);
  room.phase = "lobby"; room.results = []; room.answers = {}; room.prompts = []; room.round = 0; room.sd = null; room.sdPrompt = null; room.dna = null;
  for (const p of room.players) p.score = 0;
});

export const react = (code: string, uid: string, e: unknown) => mutate(code, (room) => {
  const p = mustBeIn(room, uid);
  if (typeof e !== "string" || !REACTIONS.includes(e)) throw new PartyError("Unknown reaction.");
  const now = Date.now();
  room.reactions = [...room.reactions.filter((r) => now - r.at < 8000), { id: room.nextReaction++, pid: p.pid, e, at: now }].slice(-40);
});

/** Read the room, ending the round on the server if its timer ran out. */
export async function getRoom(code: string): Promise<Room> {
  const room = await load(code);
  // timer ran out: show results, but give answers that are still being judged a moment to land
  const due = (r: Room) => r.phase === "answer" && Date.now() > r.deadline + 1500 &&
    (Date.now() > r.deadline + JUDGE_GRACE_MS || !Object.values(r.answers).some((a) => a.pending));
  if (due(room)) return mutate(code, (r) => { if (due(r)) finalizeRound(r); });
  // prompt generation crashed mid-way (e.g. server restart): let the host try again
  if (room.phase === "starting" && Date.now() - room.startingAt > 60000) return mutate(code, (r) => { if (r.phase === "starting") r.phase = "lobby"; });
  return room;
}

/** What a player is allowed to see. Hides other players' answers until the reveal and never exposes uids. */
export function view(room: Room, uid: string) {
  const mine = me(room, uid);
  const answering = room.phase === "answer";
  return {
    code: room.code, v: room.v, phase: room.phase, host: room.host, you: mine?.pid ?? null, now: Date.now(),
    settings: room.settings, round: room.round, totalRounds: room.settings.rounds,
    sd: room.sd ?? null, sdSeconds: SD_SECONDS, dna: room.phase === "final" ? room.dna ?? null : null,
    prompt: room.phase === "answer" || room.phase === "reveal" ? room.prompts[room.round] : null,
    startsAt: room.startsAt, deadline: room.deadline, revealAt: room.revealAt, takeoverMs: REVEAL_TAKEOVER_MS,
    players: room.players.map(({ pid, name, avatar, score }) => ({ pid, name, avatar, score, done: answering ? Boolean(room.answers[pid]?.final || room.answers[pid]?.pending) : false })),
    canSudden: room.settings.sudden && !room.sd && Boolean(room.sdPrompt) && room.players.length >= 2,
    myAnswer: mine && answering ? (({ answer, tries, final, pending, rejected, failKind }: Answer) => ({ answer: pending ?? answer, tries, final, pending: Boolean(pending), rejected: rejected ?? null, failKind: rejected ? failKind ?? "made_up" : null }))(
      room.answers[mine.pid] ?? { answer: null, key: null, share: 0, tier: null, quip: "", tries: 0, final: false, at: 0 }) : null,
    results: room.results,
    reactions: room.reactions,
    chat: room.chat ?? [],
    events: (room.events ?? []).filter((e) => Date.now() - e.at < 15000),
    kicked: !mine && (room.kicked ?? []).includes(uid),
  };
}

// ------------------------------------------------------------------ Room DNA
// One document per player (by uid), shared by every room they play in. Only in-game party answers.
type Dna = {
  games: number; answers: number; rounds: number; misses: number;
  rare: number; common: number; speed: number; jinx: number; only: number; repeats: number;
  cats: Record<string, number>;
  seen: Record<string, { t: number; w: string[] }>;            // answer key -> when, and in front of whom (uids)
};
const dnaKey = (uid: string) => `dna:${uid}`;
const emptyDna = (): Dna => ({ games: 0, answers: 0, rounds: 0, misses: 0, rare: 0, common: 0, speed: 0, jinx: 0, only: 0, repeats: 0, cats: {}, seen: {} });
const cap = (s: string) => s.replace(/\b\w/g, (c) => c.toUpperCase());

/** A player's two strongest traits, as playful labels with a percentage. */
export function traitsFor(d: Dna): Trait[] {
  if (d.answers < 2) return [{ id: "new", name: "Fresh Recruit", e: "🌱", pct: 100 }];
  const pc = (n: number, of: number) => Math.round((n / Math.max(1, of)) * 100);
  const [topCat, topN] = Object.entries(d.cats).filter(([c]) => c && c !== "anything").sort((a, b) => b[1] - a[1])[0] ?? ["", 0];
  const all: Trait[] = [
    { id: "wild", name: "The Wildcard", e: "🃏", pct: pc(d.rare, d.answers) },
    { id: "obvious", name: "Captain Obvious", e: "🥱", pct: pc(d.common, d.answers) },
    { id: "lone", name: "The Lone Wolf", e: "🐺", pct: pc(d.only, d.answers) },
    { id: "jinx", name: "The Mind Twin", e: "👯", pct: pc(d.jinx, d.answers) },
    { id: "speed", name: "Speed Demon", e: "⚡", pct: Math.round(d.speed / Math.max(1, d.answers) / 20 * 100) },
    { id: "crash", name: "Crash Pilot", e: "💥", pct: pc(d.misses, d.rounds) },
    { id: "repeat", name: "Broken Record", e: "📼", pct: pc(d.repeats, d.answers) },
    ...(topCat ? [{ id: "cat", name: `The ${cap(topCat)} Thinker`, e: "🧠", pct: pc(topN, d.answers) }] : []),
  ];
  // weights keep rare-but-meaningful traits competitive with common ones
  const weight: Record<string, number> = { wild: 1.5, obvious: 1, lone: 1.3, jinx: 1.6, speed: 0.8, crash: 0.9, repeat: 1.6, cat: 0.9 };
  return all.filter((t) => t.pct >= 15).sort((a, b) => b.pct * weight[b.id] - a.pct * weight[a.id]).slice(0, 2)
    .concat(all.filter((t) => t.pct >= 15).length ? [] : [{ id: "balanced", name: "The All-Rounder", e: "⚖️", pct: 100 }]);
}

/** At the end of a game: fold it into each player's DNA and put everyone's traits on the podium. Once per game. */
async function saveDna(code: string) {
  try {
    const room = await kv.get<Room>(rk(code));
    if (!room || room.phase !== "final" || !room.settings.dna) return;
    if (!(await kv.setNx(`dnasaved:${code}:${room.created}:${room.gameNo ?? 0}`, 1, ROOM_TTL))) return;
    const promptCat = new Map(room.prompts.map((p) => [p.text, p.category]));
    const out: NonNullable<Room["dna"]> = {};
    await Promise.all(room.players.map(async (p) => {
      const d = { ...emptyDna(), ...((await kv.get<Dna>(dnaKey(p.uid)).catch(() => null)) ?? {}) };
      const others = room.players.filter((q) => q.uid !== p.uid).map((q) => q.uid);
      let played = false;
      for (const res of room.results) {
        const r = res.rows.find((x) => x.pid === p.pid); if (!r) continue;
        played = true; d.rounds++;
        if (!r.tier || !r.answer) { d.misses++; continue; }
        d.answers++; d.speed += r.speed;
        if (r.tier >= "t4") d.rare++; if (r.tier === "t1") d.common++;
        if (r.jinx) d.jinx++; if (r.only) d.only++; if (r.repeat) d.repeats++;
        const c = promptCat.get(res.prompt) ?? ""; if (c) d.cats[c] = (d.cats[c] ?? 0) + 1;
        const k = key(r.answer), prev = d.seen[k];
        d.seen[k] = { t: Date.now(), w: [...new Set([...(prev?.w ?? []), ...others])].slice(-20) };
      }
      if (!played) return;
      d.games++;
      const keys = Object.entries(d.seen).sort((a, b) => b[1].t - a[1].t).slice(0, DNA_MAX_SEEN);
      d.seen = Object.fromEntries(keys);
      await kv.set(dnaKey(p.uid), d, DNA_TTL);
      out[p.pid] = { traits: traitsFor(d), answers: d.answers, games: d.games, repeats: room.results.reduce((n, res) => n + (res.rows.find((x) => x.pid === p.pid)?.repeat ? 1 : 0), 0) };
    }));
    await mutate(code, (r) => { if (r.phase === "final") r.dna = out; });
  } catch (e) { console.error("saveDna:", (e as Error).message); }
}
