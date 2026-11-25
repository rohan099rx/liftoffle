import "server-only";
import { randomInt } from "node:crypto";
import { after } from "next/server";
import { CATEGORIES, generatePrompts, judge, JudgeBusy, MAX_TRIES, quipFor, recordAnswer, surveyFor, tierFor, warmSurveys, type Prompt } from "./game";
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
export type ResultRow = { pid: string; answer: string | null; tier: string | null; base: number; jinx: number; only: number; speed: number; points: number; quip: string; unverified?: boolean; fails?: Blooper[] };
type Room = {
  code: string; v: number; created: number; host: string;
  phase: "lobby" | "starting" | "answer" | "reveal" | "final";
  settings: { category: string; rounds: number; seconds: number };
  players: Player[]; nextPid: number;
  prompts: Prompt[]; used: string[]; round: number; startingAt: number; startsAt: number; deadline: number; revealAt: number;
  answers: Record<string, Answer>;
  results: { prompt: string; rows: ResultRow[] }[];
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
  const valid = room.players.map((p) => ({ p, a: room.answers[p.pid] })).filter((x) => x.a?.key);
  const groups = new Map<string, number>();
  for (const { a } of valid) groups.set(a.key!, (groups.get(a.key!) ?? 0) + 1);
  const window = Math.max(1, room.deadline - room.startsAt);
  const rows: ResultRow[] = room.players.map((p) => {
    const a = room.answers[p.pid];
    const fails = a?.fails?.length ? a.fails : undefined;
    if (!a?.key) return { pid: p.pid, answer: null, tier: null, base: 0, jinx: 0, only: 0, speed: 0, points: 0,
      quip: a?.failKind === "busy" ? "🛰️ The judge was too busy to check this one. No points, sorry!" : a?.fails?.length ? "Crashed on the pad." : a ? "Chickened out. 🐔" : "Never left the pad.", fails };
    const t = tierFor(a.share), k = groups.get(a.key)!;
    const base = Math.round(t.score / k);
    const only = k === 1 && valid.length >= 2 ? ONLY_YOU_BONUS : 0;
    const speed = Math.round(SPEED_MAX * Math.min(1, Math.max(0, (room.deadline - a.at) / window)));
    return { pid: p.pid, answer: a.answer, tier: t.key, base, jinx: k > 1 ? k : 0, only, speed, points: base + only + speed, quip: a.quip, unverified: a.unverified || undefined, fails };
  });
  for (const r of rows) { const p = room.players.find((x) => x.pid === r.pid); if (p) p.score += r.points; }
  room.results.push({ prompt: room.prompts[room.round].text, rows });
  room.phase = "reveal"; room.revealAt = Date.now();
}

const allDone = (room: Room) => room.players.length > 0 && room.players.every((p) => room.answers[p.pid]?.final);

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
export const endGameEarly = (code: string, uid: string) => mutate(code, (room) => {
  mustHost(room, uid);
  if (room.phase !== "reveal" && room.phase !== "answer") throw new PartyError("No game is running.", 409);
  if (room.phase === "answer") finalizeRound(room);
  room.phase = "final"; note(room, "🏁 The host ended the game");
});

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
      while (all.length < settings.rounds) {
        const batch = await generatePrompts(settings.category, [...used, ...all.map((p) => p.text)], `prep-${code}-${Date.now()}-${all.length}`);
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
    const all: Prompt[] = (prep ?? []).filter((p) => !r.used.includes(p.text)).slice(0, r.settings.rounds);
    if (prep) void kv.del(prepKey(code, r.settings.category)).catch(() => {});
    // generatePrompts returns 7 at a time; ask again for 10-round games
    while (all.length < r.settings.rounds) {
      const batch = await generatePrompts(r.settings.category, [...r.used, ...all.map((p) => p.text)], `party-${code}-${Date.now()}-${all.length}`);
      const fresh = batch.filter((p) => !all.some((q) => q.id === p.id));
      if (!fresh.length) break;
      all.push(...fresh);
    }
    prompts = all.slice(0, r.settings.rounds);
    after(() => warmSurveys(prompts)); // build the rarity surveys while players read the first prompt
  } catch (e) {
    await mutate(code, (room) => { room.phase = "lobby"; });
    throw e;
  }
  return mutate(code, (room) => {
    room.prompts = prompts; room.used = [...room.used, ...prompts.map((p) => p.text)].slice(-80);
    room.settings.rounds = prompts.length;
    room.round = 0; room.results = []; room.answers = {};
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
    try { verdict = await judge(prompt, raw); break; }
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
      const final = tries >= MAX_TRIES || Date.now() > room.deadline;
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
  const upcoming = room.phase === "answer" ? room.prompts[room.round + 1] : undefined;
  if (upcoming) after(() => surveyFor(upcoming, 0).then(() => undefined)); // get the next prompt's survey ready
  return room;
}

const advance = (code: string, uid: string) => mutate(code, (room) => {
  const p = mustBeIn(room, uid);
  if (room.phase !== "reveal") throw new PartyError("Not ready for the next round yet.", 409);
  if (p.pid !== room.host && Date.now() - room.revealAt < REVEAL_TAKEOVER_MS) throw new PartyError("Waiting for the host to continue.", 403);
  if (room.round + 1 >= room.prompts.length) { room.phase = "final"; return; }
  room.round++; room.answers = {};
  room.startsAt = Date.now() + GET_READY_MS; room.deadline = room.startsAt + room.settings.seconds * 1000;
  room.phase = "answer";
});

export const playAgain = (code: string, uid: string) => mutate(code, (room) => {
  mustHost(room, uid);
  if (room.phase !== "final") throw new PartyError("Finish this game first.", 409);
  room.phase = "lobby"; room.results = []; room.answers = {}; room.prompts = []; room.round = 0;
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
    settings: room.settings, round: room.round, totalRounds: room.prompts.length || room.settings.rounds,
    prompt: room.phase === "answer" || room.phase === "reveal" ? room.prompts[room.round] : null,
    startsAt: room.startsAt, deadline: room.deadline, revealAt: room.revealAt, takeoverMs: REVEAL_TAKEOVER_MS,
    players: room.players.map(({ pid, name, avatar, score }) => ({ pid, name, avatar, score, done: answering ? Boolean(room.answers[pid]?.final || room.answers[pid]?.pending) : false })),
    myAnswer: mine && answering ? (({ answer, tries, final, pending, rejected, failKind }: Answer) => ({ answer: pending ?? answer, tries, final, pending: Boolean(pending), rejected: rejected ?? null, failKind: rejected ? failKind ?? "made_up" : null }))(
      room.answers[mine.pid] ?? { answer: null, key: null, share: 0, tier: null, quip: "", tries: 0, final: false, at: 0 }) : null,
    results: room.results,
    reactions: room.reactions,
    chat: room.chat ?? [],
    events: (room.events ?? []).filter((e) => Date.now() - e.at < 15000),
    kicked: !mine && (room.kicked ?? []).includes(uid),
  };
}
