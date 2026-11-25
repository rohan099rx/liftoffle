"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Sky from "../Sky";
import { api, beep, liveGet } from "../client";
import { BadgeToasts, unlock } from "../achievements";
import { Icon } from "../icons";
import { CrashCard, failEmoji, isMash, MASH_LINES, pick, REPEAT_LINES, sfx } from "../fun";

// ------------------------------------------------------------------ types
type Player = { pid: string; name: string; avatar: string; score: number; done: boolean };
type Blooper = { text: string; why: string; kind: string };
type Row = { pid: string; answer: string | null; tier: string | null; base: number; jinx: number; only: number; speed: number; points: number; quip: string; unverified?: boolean; fails?: Blooper[]; repeat?: number };
type Trait = { id: string; name: string; e: string; pct: number };
type View = {
  code: string; v: number; phase: "lobby" | "starting" | "answer" | "reveal" | "final"; host: string; you: string | null; now: number;
  settings: { category: string; rounds: number; seconds: number; sudden?: boolean; dna?: boolean }; round: number; totalRounds: number;
  dna: Record<string, { traits: Trait[]; answers: number; games: number; repeats: number }> | null;
  sd: { finalists: string[]; done: boolean; winner: string | null } | null; sdSeconds: number; canSudden: boolean;
  prompt: { id: string; text: string; category: string } | null;
  startsAt: number; deadline: number; revealAt: number; takeoverMs: number;
  players: Player[]; myAnswer: { answer: string | null; tries: number; final: boolean; pending: boolean; rejected: string | null; failKind: string | null } | null;
  results: { prompt: string; rows: Row[]; sd?: boolean }[];
  reactions: { id: number; pid: string; e: string; at: number }[];
  chat: { id: number; pid: string; name: string; avatar: string; text: string; at: number }[];
  events: { id: number; text: string; at: number; pid?: string }[];
  kicked: boolean;
};

const AVATARS = ["🚀", "🛸", "👽", "🌟", "🪐", "☄️", "🐱", "🦊", "🐼", "🐸", "🦄", "🤖", "🐙", "🦖", "🍕", "👾"];
const REACTIONS = ["🔥", "😂", "🤯", "👏", "🚀", "😱"];
const CATS = ["anything", "food", "nature", "music", "movies & tv", "sports", "geography", "space", "science", "history", "games"];
const TIER_NAMES: Record<string, string> = { t1: "GROUND CREW", t2: "PILOT", t3: "ASTRONAUT", t4: "VOYAGER", t5: "LIGHT-YEAR" };
const MEDALS = ["🥇", "🥈", "🥉"];

const ls = {
  get<T>(k: string, d: T): T { try { const v = localStorage.getItem(k); return v ? (JSON.parse(v) as T) : d; } catch { return d; } },
  set(k: string, v: unknown) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* storage may be blocked */ } },
};

// ------------------------------------------------------------------ page
export default function Party() {
  const [name, setName] = useState("");
  const [avatar, setAvatar] = useState(AVATARS[0]);
  const [settings, setSettings] = useState({ category: "anything", rounds: 7, seconds: 30, sudden: true, dna: true });
  const [joinCode, setJoinCode] = useState("");
  const [code, setCode] = useState<string | null>(null);
  const [room, setRoom] = useState<View | null>(null);
  const [skew, setSkew] = useState(0);
  const [now, setNow] = useState(() => Date.now());
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [feedback, setFeedback] = useState<string | null>(null);
  const [sound, setSound] = useState(true);
  const [copied, setCopied] = useState(false);
  const [boostKey, setBoostKey] = useState(0);
  const [boostTier, setBoostTier] = useState<string | null>(null);
  const vRef = useRef(0);
  const inputRef = useRef<HTMLInputElement>(null);

  const play = useCallback((f: number[], d?: number) => { if (sound) beep(f, d); }, [sound]);

  // ---- boot: identity from this browser, room code from the link
  useEffect(() => {
    setName(ls.get("lo:nick", "")); setAvatar(ls.get("lo:avatar", AVATARS[Math.floor(Math.random() * AVATARS.length)]));
    setSound(ls.get("lo:sound", true));
    const c = new URLSearchParams(location.search).get("code")?.toUpperCase();
    if (c && /^[A-Z]{4}$/.test(c)) { setJoinCode(c); setCode(c); }
  }, []);

  // Apply a room view, ignoring any response older than what's already on screen (a poll that left
  // before your own action can arrive after it and would otherwise flash an earlier state).
  const codeRef = useRef<string | null>(null);
  const serverNowRef = useRef(0);
  const phaseRef = useRef<string>("lobby");
  const apply = useCallback((v: View) => {
    if (v.code === codeRef.current && v.v < vRef.current) return;
    codeRef.current = v.code; vRef.current = v.v; phaseRef.current = v.phase;
    setSkew(v.now - Date.now()); setRoom(v);
  }, []);

  // ---- live updates. Each request waits on the server until the room changes (pushed to the server
  // instantly by Redis pub/sub), so changes show up in ~0.1-0.3s without hammering the server.
  // Built to survive real phones: every request times out, the loop never dies, it re-syncs the moment
  // you come back to the tab or regain signal, and a watchdog restarts it if it ever goes quiet.
  const [conn, setConn] = useState<"ok" | "slow" | "lost">("ok");
  const kickRef = useRef<() => void>(() => {});
  useEffect(() => {
    if (!code) return;
    let stop = false, inflight = false, inflightSince = 0, inflightWait = false, gen = 0, fails = 0, lastOk = Date.now();
    let ac: AbortController | null = null;
    let t: ReturnType<typeof setTimeout> | undefined;
    const schedule = (ms: number) => { clearTimeout(t); t = setTimeout(tick, ms); };
    const abandon = () => { gen++; inflight = false; ac?.abort(); ac = null; };
    async function tick() {
      if (stop || inflight) return;
      const my = ++gen; // if this request gets abandoned, its late answer is ignored
      const wait = !document.hidden && vRef.current > 0; // hidden tabs just check in every few seconds
      inflight = true; inflightSince = Date.now(); inflightWait = wait; ac = new AbortController();
      let quick = false;
      try {
        const t0 = Date.now();
        const url = `/api/party?code=${code}&v=${vRef.current}`;
        const r = wait ? await liveGet<View & { same?: boolean }>(`${url}&wait=1`, 6000, ac.signal) : await api<View & { same?: boolean }>(url, undefined, 6000, ac.signal);
        if (stop || my !== gen) return;
        if (r.same) { setSkew(r.now - Date.now()); quick = wait && Date.now() - t0 < 250; } else apply(r);
        fails = 0; lastOk = Date.now(); setConn("ok");
      } catch (e) {
        if (stop || my !== gen) return;
        const err = e as Error & { status?: number };
        if (err.status === 404) { setError(err.message); setCode(null); setRoom(null); history.replaceState(null, "", "/party"); stop = true; return; }
        fails++; setConn(fails >= 3 ? "lost" : "slow");
      } finally { if (my === gen) inflight = false; }
      if (stop || my !== gen) return;
      // a waiting request that came back "nothing new" instantly means live updates are off: fall back to polling
      schedule(fails ? Math.min(5000, 800 * fails) : document.hidden ? 5000 : quick ? 700 : 0);
    }
    // re-sync now: drop whatever request is open (it may be on a dead connection) and start a fresh one
    const kick = () => { if (document.hidden) return; if (inflight && Date.now() - inflightSince < 1500) return; if (inflight) abandon(); schedule(0); };
    kickRef.current = kick;
    const dog = setInterval(() => {
      if (stop || document.hidden) return;
      if (inflight && Date.now() - inflightSince > (inflightWait ? 28000 : 8000)) { abandon(); schedule(0); }
      else if (!inflight && Date.now() - lastOk > 8000) schedule(0);
    }, 3000);
    document.addEventListener("visibilitychange", kick);
    for (const ev of ["focus", "online", "pageshow"]) addEventListener(ev, kick);
    vRef.current = 0;
    void tick();
    return () => {
      stop = true; clearTimeout(t); clearInterval(dog); abandon();
      document.removeEventListener("visibilitychange", kick);
      for (const ev of ["focus", "online", "pageshow"]) removeEventListener(ev, kick);
    };
  }, [code, apply]);

  // when the answer timer runs out, ask for the results straight away instead of waiting for the next poll
  const expired = room?.phase === "answer" && serverNowRef.current > room.deadline + 1700;
  useEffect(() => { if (expired) kickRef.current(); }, [expired, room?.round]);

  // the on-screen clock only needs fast ticks while a countdown is showing
  const fastClock = room?.phase === "answer" || room?.phase === "reveal";
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), fastClock ? 250 : 1000); return () => clearInterval(t); }, [fastClock]);
  const serverNow = now + skew;
  serverNowRef.current = serverNow;

  // ---- derived
  const me = room?.players.find((p) => p.pid === room.you) ?? null;
  const isHost = !!room && room.you === room.host;
  const byPid = useMemo(() => new Map(room?.players.map((p) => [p.pid, p]) ?? []), [room]);
  const lastResult = room?.results[room.results.length - 1];
  const myLast = lastResult?.rows.find((r) => r.pid === room?.you);
  const maxPossible = (room?.totalRounds ?? 7) * 150;
  const skyScore = me ? Math.min(700, Math.round((me.score / Math.max(1, maxPossible)) * 700 * 1.6)) : 0;
  const countdown = room ? Math.ceil((room.startsAt - serverNow) / 1000) : 0;
  // Sudden Death: the final face-off between the top two
  const sdLive = !!room?.sd && !room.sd.done && room.phase === "answer";
  const finalist = !!room?.sd && !!room.you && room.sd.finalists.includes(room.you);
  const timeLeft = room ? Math.max(0, room.deadline - serverNow) : 0;
  const timeFrac = room ? Math.min(1, timeLeft / Math.max(1, room.deadline - room.startsAt)) : 0;

  // ---- sound + rocket effects on phase changes
  const prevPhase = useRef<string | null>(null), prevRound = useRef(-1);
  useEffect(() => {
    if (!room) return;
    const key = `${room.phase}:${room.round}`;
    if (prevPhase.current === key) return;
    const was = prevPhase.current; prevPhase.current = key;
    if (room.phase === "answer" && prevRound.current !== room.round) { prevRound.current = room.round; setDraft(""); setFeedback(null); if (room.sd && !room.sd.done) play([196, 196, 233, 262, 196], 0.22); else play([392, 523]); }
    if (room.phase === "reveal" && was && room.sd?.done && room.results.at(-1)?.sd) {
      setTimeout(() => play(room.sd!.winner === room.you ? [523, 659, 784, 1047, 1319, 1568] : [262, 330, 392, 523], 0.12), 1900);
      if (room.sd.winner && room.sd.winner === room.you) setTimeout(() => unlock("sudden_death"), 2400);
    }
    if (room.phase === "reveal" && was) {
      if (myLast?.points) { setBoostTier(myLast.tier); setBoostKey((k) => k + 1); }
      play(myLast?.only ? [523, 659, 784, 1047] : myLast?.jinx ? [330, 262] : myLast?.points ? [523, 659, 784] : [220, 165]);
    }
    if (room.phase === "final" && was) {
      play([523, 659, 784, 1047, 784, 1047, 1319], 0.12);
      const top = Math.max(...room.players.map((p) => p.score));
      if (me && room.players.length >= 2 && me.score === top && top > 0) unlock("party_champ");
      // Blooper of the game: the player with the most rejected answers
      const fails = new Map<string, number>();
      for (const res of room.results) for (const r of res.rows) fails.set(r.pid, (fails.get(r.pid) ?? 0) + (r.fails?.length ?? 0));
      const worst = [...fails.entries()].sort((a, b) => b[1] - a[1])[0];
      if (worst && worst[1] > 0 && worst[0] === room.you) setTimeout(() => unlock("class_clown"), 1800);
    }
  }, [room, myLast, play]);
  // a rejection arrives through the live update, not the button press: buzz and put the cursor back
  const rejected = room?.myAnswer?.rejected ?? null;
  const [crashKey, setCrashKey] = useState(0);
  useEffect(() => { if (rejected) { setCrashKey((k) => k + 1); if (sound) sfx.trombone(); setTimeout(() => inputRef.current?.select(), 50); } }, [rejected, sound]);
  // instant comebacks for keyboard mashes and repeats: they don't cost a try
  const [quickCrash, setQuickCrash] = useState<{ text: string; kind: string; seed: number } | null>(null);
  useEffect(() => { setQuickCrash(null); }, [room?.round, room?.phase]);

  // tick-tock in the last 5 seconds
  const lastTick = useRef(-1);
  useEffect(() => {
    if (room?.phase !== "answer" || room.myAnswer?.final) return;
    const s = Math.ceil(timeLeft / 1000);
    if (countdown > 0) { if (countdown !== lastTick.current && countdown <= 3) { lastTick.current = countdown; play([660], 0.06); } return; }
    if (s <= 5 && s > 0 && s !== lastTick.current) { lastTick.current = s; play([s <= 2 ? 990 : 880], 0.05); }
  }, [timeLeft, countdown, room, play]);
  useEffect(() => { if (room?.phase === "answer" && countdown <= 0 && !room.myAnswer?.final) inputRef.current?.focus(); }, [room?.phase, room?.round, countdown, room?.myAnswer?.final]);

  // ---- toasts for room events (joins, leaves, host changes). Old events from before you arrived are skipped.
  const [toasts, setToasts] = useState<{ id: number; text: string }[]>([]);
  const seenEvent = useRef<number | null>(null);
  useEffect(() => {
    if (!room) return;
    const evs = room.events ?? [];
    const newest = evs.length ? evs[evs.length - 1].id : 0;
    if (seenEvent.current === null) { seenEvent.current = newest; return; }
    const fresh = evs.filter((e) => e.id > seenEvent.current! && e.pid !== room.you);
    if (!fresh.length) return;
    seenEvent.current = newest;
    setToasts((t) => [...t, ...fresh.map((e) => ({ id: e.id, text: e.text }))].slice(-4));
    play([660, 880], 0.05);
    for (const e of fresh) setTimeout(() => setToasts((t) => t.filter((x) => x.id !== e.id)), 3800);
  }, [room, play]);
  useEffect(() => { seenEvent.current = null; }, [code]);

  // ---- actions
  async function act(action: string, extra: Record<string, unknown> = {}, label?: string) {
    if (busy) return null;
    setBusy(label ?? "…"); setError(null);
    try {
      const r = await api<View & { feedback?: { ok: boolean; final: boolean; reason?: string; triesLeft?: number } }>("/api/party", { action, code: code ?? undefined, ...extra });
      if (r && "phase" in r) apply(r);
      return r;
    } catch (e) {
      const err = e as Error & { status?: number };
      setError(err.message);
      if (err.status === 409) kickRef.current(); // e.g. "round is over": re-sync instead of leaving a stale screen
    } finally { setBusy(null); }
  }
  function saveIdentity() { ls.set("lo:nick", name.trim()); ls.set("lo:avatar", avatar); }
  async function create() {
    if (!name.trim()) return setError("Pick a nickname first.");
    saveIdentity();
    const r = await act("create", { name, avatar, settings }, "Building your launch pad…");
    if (r?.code) { setCode(r.code); history.replaceState(null, "", `/party?code=${r.code}`); }
  }
  async function join(c = joinCode) {
    if (!name.trim()) return setError("Pick a nickname first.");
    const cc = c.trim().toUpperCase();
    if (!/^[A-Z]{4}$/.test(cc)) return setError("Room codes are 4 letters.");
    saveIdentity();
    setBusy("Docking…"); setError(null);
    try {
      const r = await api<View>("/api/party", { action: "join", code: cc, name, avatar });
      apply(r); setCode(cc); history.replaceState(null, "", `/party?code=${cc}`); play([392, 523, 659]);
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(null); }
  }
  async function answer(skip = false) {
    const a = draft.trim();
    if (!skip && !a) return;
    setFeedback(null); setQuickCrash(null);
    if (new Date().getHours() < 5) unlock("night_owl");
    if (!skip && isMash(a)) { setQuickCrash({ text: pick(MASH_LINES), kind: "gibberish", seed: Date.now() }); setCrashKey((k) => k + 1); unlock("cat_keyboard"); if (sound) sfx.boing(); inputRef.current?.select(); return; }
    const prevTry = room?.myAnswer?.rejected?.match(/^“(.*)”:/)?.[1];
    if (!skip && prevTry && prevTry.toLowerCase().trim() === a.toLowerCase()) { setQuickCrash({ text: pick(REPEAT_LINES), kind: "joke", seed: Date.now() }); unlock("broken_record"); if (sound) sfx.boing(); inputRef.current?.select(); return; }
    if (skip && sound) sfx.cluck();
    const r = await act("answer", skip ? { skip: true } : { answer: a }, "Locking in…");
    const f = r?.feedback;
    if (!f) return;
    if (f.ok) play([523, 784]); // locked in instantly; the judge's verdict arrives with the next live update
    else if (!f.final) { setFeedback(`${f.reason} ${f.triesLeft} ${f.triesLeft === 1 ? "try" : "tries"} left.`); play([180]); inputRef.current?.select(); }
    else if (!skip) { setFeedback(`${f.reason} Out of tries this round.`); play([220, 165]); }
  }
  async function leave() {
    if (code) await act("leave");
    setCode(null); setRoom(null); vRef.current = 0; codeRef.current = null; history.replaceState(null, "", "/party");
  }
  function changeSettings(raw: { category: string; rounds: number; seconds: number; sudden?: boolean; dna?: boolean }) {
    const next = { ...raw, sudden: raw.sudden !== false, dna: raw.dna !== false };
    setSettings(next);
    if (room && isHost && room.phase === "lobby") void act("settings", { settings: next });
  }
  async function copyInvite() {
    try { await navigator.clipboard.writeText(`${location.origin}/party?code=${room?.code}`); setCopied(true); setTimeout(() => setCopied(false), 1800); }
    catch { setError("Copy was blocked. Share the code instead."); }
  }
  async function shareInvite() {
    const url = `${location.origin}/party?code=${room?.code}`;
    const text = `🚀 Join my Liftoffle party! Room ${room?.code}. Name the thing nobody else will.`;
    if (navigator.share) { try { await navigator.share({ title: "Liftoffle party", text, url }); return; } catch { /* closed the share sheet */ return; } }
    window.open(`https://wa.me/?text=${encodeURIComponent(`${text}\n${url}`)}`, "_blank", "noopener");
  }
  async function shareResult() {
    if (!room) return;
    const st = [...room.players].sort((a, b) => b.score - a.score);
    const text = `🚀 Liftoffle party · room ${room.code}\n${st.slice(0, 5).map((p, i) => `${MEDALS[i] ?? `#${i + 1}`} ${p.avatar} ${p.name} ${p.score}`).join("\n")}\n${location.origin}/party`;
    try { await navigator.clipboard.writeText(text); setCopied(true); setTimeout(() => setCopied(false), 1800); } catch { setError("Copy was blocked by the browser."); }
  }

  // ------------------------------------------------------------------ render
  const settingsLocked = !!room && !isHost;
  const SettingsPicker = (
    <div className="p-settings">
      <div><small>CATEGORY</small><div className="chips">{CATS.map((c) => <button key={c} disabled={settingsLocked} className={c === (room?.settings.category ?? settings.category) ? "chip on" : "chip"} onClick={() => changeSettings({ ...(room?.settings ?? settings), category: c })}>{c}</button>)}</div></div>
      <div className="row wrap p-two">
        <div><small>ROUNDS</small><div className="chips">{[5, 7, 10].map((n) => <button key={n} disabled={settingsLocked} className={n === (room?.settings.rounds ?? settings.rounds) ? "chip on" : "chip"} onClick={() => changeSettings({ ...(room?.settings ?? settings), rounds: n })}>{n}</button>)}</div></div>
        <div><small>SUDDEN DEATH FINAL</small><div className="chips">{[true, false].map((on) => <button key={String(on)} disabled={settingsLocked} className={on === ((room?.settings ?? settings).sudden !== false) ? "chip on" : "chip"} onClick={() => changeSettings({ ...(room?.settings ?? settings), sudden: on })}>{on ? "⚔️ on" : "off"}</button>)}</div></div>
        <div><small>ROOM DNA</small><div className="chips">{[true, false].map((on) => <button key={String(on)} disabled={settingsLocked} className={on === ((room?.settings ?? settings).dna !== false) ? "chip on" : "chip"} onClick={() => changeSettings({ ...(room?.settings ?? settings), dna: on })}>{on ? "🧬 on" : "off"}</button>)}</div></div>
        <div><small>SECONDS PER PROMPT</small><div className="chips">{[20, 30, 45, 60].map((n) => <button key={n} disabled={settingsLocked} className={n === (room?.settings.seconds ?? settings.seconds) ? "chip on" : "chip"} onClick={() => changeSettings({ ...(room?.settings ?? settings), seconds: n })}>{n}s</button>)}</div></div>
      </div>
    </div>
  );

  const Identity = (
    <div className="p-identity">
      <label className="nick">Your name
        <input value={name} maxLength={16} placeholder="e.g. Sam" onChange={(e) => setName(e.target.value.replace(/[^\p{L}\p{N} _.'-]/gu, ""))} />
      </label>
      <div className="p-avatars" role="radiogroup" aria-label="Pick your rocket">
        {AVATARS.map((a) => <button key={a} role="radio" aria-checked={a === avatar} className={a === avatar ? "p-av on" : "p-av"} onClick={() => setAvatar(a)}>{a}</button>)}
      </div>
    </div>
  );

  return (
    <main>
      <Sky score={skyScore} boostKey={boostKey} boostTier={boostTier} crashKey={crashKey} />
      <BadgeToasts sound={sound} />
      <Reactions room={room} serverNow={serverNow} byPid={byPid} />
      {room?.phase === "final" && <Confetti />}

      <header className="hud">
        <a className="box brand" href="/" aria-label="Back to solo game"><img className="brand-mark" src="/brand/mark.svg" alt="" />LIFTOFF<span>LE</span><small>PARTY{room ? ` · ${room.code}` : ""}</small></a>
        {room && room.phase !== "lobby" && room.phase !== "starting" && (
          <div className={`box center${room.sd && room.round >= room.totalRounds ? " sd-box" : ""}`}><small>ROUND</small><b>{room.sd && room.round >= room.totalRounds ? "FINAL" : `${Math.min(room.round + 1, room.totalRounds)}/${room.totalRounds}`}</b><small className="zone">{room.sd && room.round >= room.totalRounds ? "SUDDEN DEATH" : room.settings.category.toUpperCase()}</small></div>
        )}
        <div className="box right"><small>{me ? `${me.avatar} ${me.name}`.toUpperCase() : "SCORE"}</small><b key={me?.score ?? 0} className="bump">{me?.score ?? 0}</b>
          <button className="mute" onClick={() => { setSound(!sound); ls.set("lo:sound", !sound); }} aria-pressed={!sound}>{sound ? "SOUND ON" : "MUTED"}</button>
        </div>
      </header>

      <div className="p-toasts" aria-live="polite">{toasts.map((t) => <div key={t.id} className="p-toast">{t.text}</div>)}</div>
      {room?.phase === "answer" && countdown <= 0 && timeLeft > 0 && timeLeft < 5000 && !room.myAnswer?.final && !room.myAnswer?.pending && <div className="p-danger" aria-hidden="true" />}

      <section className="panel" aria-live="polite" key={room ? `${room.phase}:${room.round}` : "out"}>
        {code && conn !== "ok" && (
          <p className={conn === "lost" ? "err p-conn" : "busy p-conn"}><span className="dot" />{conn === "lost" ? "Connection lost. Reconnecting…" : "Connection is slow…"}
            {conn === "lost" && <button className="link" onClick={() => kickRef.current()}>retry now</button>}</p>
        )}
        {error && <p className="err">{error}</p>}
        {busy && busy !== "…" && room?.phase !== "starting" && <p className="busy"><span className="dot" />{busy}</p>}

        {room?.kicked && <p className="err">The host removed you from room {room.code}.</p>}
        {/* ---------- not in a room yet ---------- */}
        {(!room || !room.you) && (
          <div>
            <h1>{room ? `Join room ${room.code}` : "Play with friends"}</h1>
            <p className="lede">{room
              ? `${room.players.map((p) => p.avatar + " " + p.name).join(", ") || "Nobody"} ${room.players.length === 1 ? "is" : "are"} waiting.${room.phase !== "lobby" ? " A game is in progress; you'll join from the next prompt." : ""}`
              : "Everyone gets the same prompt at the same time. Say something nobody else in the room says for a bonus. Match a friend and you'll split the points. JINX!"}</p>
            {Identity}
            {room?.kicked ? (
              <div className="row wrap"><button className="ghost" onClick={leave}>BACK</button></div>
            ) : room ? (
              <div className="row wrap"><button onClick={() => join(room.code)} disabled={!!busy}>JOIN {room.code} ▲</button><button className="ghost" onClick={leave}>BACK</button></div>
            ) : (
              <div className="cards">
                <div className="card">
                  <small>JOIN A ROOM</small>
                  <p>Got a 4-letter code from a friend?</p>
                  <form className="row" onSubmit={(e) => { e.preventDefault(); void join(); }}>
                    <input className="p-code-in" value={joinCode} maxLength={4} placeholder="ABCD" aria-label="Room code" autoCapitalize="characters"
                      onChange={(e) => setJoinCode(e.target.value.toUpperCase().replace(/[^A-Z]/g, ""))} />
                    <button type="submit" disabled={!!busy || joinCode.length !== 4}>JOIN</button>
                  </form>
                </div>
                <div className="card">
                  <small>HOST A ROOM</small>
                  {SettingsPicker}
                  <button onClick={create} disabled={!!busy}>CREATE ROOM ▲</button>
                </div>
              </div>
            )}
            <p className="muted small"><a className="p-link" href="/">← back to the solo daily launch</a></p>
          </div>
        )}

        {/* ---------- lobby ---------- */}
        {room?.you && room.phase === "lobby" && (
          <div>
            <div className="p-code-row">
              <div><small className="muted">ROOM CODE</small><div className="p-code">{room.code.split("").map((ch, i) => <span key={i} style={{ animationDelay: `${i * 0.08}s` }}>{ch}</span>)}</div></div>
              <div className="row wrap p-invite">
                <button onClick={shareInvite}><Icon name="share" /> Invite</button>
                <button className="ghost" onClick={copyInvite}>{copied ? "COPIED ✓" : "COPY LINK"}</button>
              </div>
            </div>
            <h2>Crew on the pad · {room.players.length}</h2>
            <ul className="p-crew">
              {room.players.map((p) => <li key={p.pid} className={p.pid === room.you ? "you" : ""}><span className="p-big">{p.avatar}</span><span>{p.name}</span>{p.pid === room.host && <em>HOST</em>}
                {isHost && p.pid !== room.you && <HostMenu name={p.name} onHost={() => act("host", { pid: p.pid })} onKick={() => act("kick", { pid: p.pid })} />}</li>)}
              {room.players.length < 3 && <li className="p-empty"><span className="p-big">＋</span><span>invite friends</span></li>}
            </ul>
            {isHost ? SettingsPicker : <p className="muted small">{room.settings.rounds} rounds · {room.settings.seconds}s each · {room.settings.category}{room.settings.sudden !== false ? " · ⚔️ sudden death final" : ""}. Waiting for the host to launch…</p>}
            {room.settings.dna !== false && <p className="dna-note">🧬 <b>Room DNA is on.</b> The game remembers the answers you give in front of these friends (in-game answers only, kept 90 days). Repeat yourself and you lose your bonus. Traits appear on the podium.</p>}
            <div className="row wrap">
              {isHost && <button onClick={() => act("start", {}, `Writing ${room.settings.rounds} fresh prompts…`)} disabled={!!busy}>{room.players.length < 2 ? "LAUNCH SOLO ▲" : `LAUNCH ${room.players.length} ROCKETS ▲`}</button>}
              <button className="ghost" onClick={leave}>LEAVE</button>
            </div>
            {isHost && room.players.length < 2 && <p className="muted small">Tip: it's way more fun with 3+. Send the invite link to your group chat.</p>}
            <Chat room={room} send={(text) => act("chat", { text })} />
          </div>
        )}

        {room?.you && room.phase === "starting" && (
          <div className="p-center"><p className="busy"><span className="dot" />Mission control is writing {room.settings.rounds} fresh prompts…</p><p className="muted small">Stretch your brain. Think weird.</p></div>
        )}

        {/* ---------- answering ---------- */}
        {room?.you && room.phase === "answer" && room.prompt && (
          countdown > 0 && sdLive ? (
            <SdIntro room={room} countdown={countdown} byPid={byPid} />
          ) : sdLive && !finalist && countdown <= 0 ? (
            <SdWatch room={room} byPid={byPid} timeLeft={timeLeft} />
          ) : countdown > 0 ? (
            <div className="p-center p-ready">
              <small className="muted">ROUND {room.round + 1} OF {room.totalRounds}</small>
              <div key={countdown} className="p-countdown">{countdown}</div>
              <p className="muted">Get ready…</p>
            </div>
          ) : (
            <div>
              <div className="p-timer" style={{ ["--f" as string]: timeFrac, ["--tc" as string]: timeFrac < 0.2 ? "var(--miss)" : timeFrac < 0.5 ? "var(--t4)" : "var(--t3)" }}><i /></div>
              <div className="rnd"><span>{sdLive ? <b className="sd-tag">⚔️ SUDDEN DEATH · ONE SHOT · ×2 POINTS</b> : `PROMPT ${room.round + 1} OF ${room.totalRounds}`}</span><span className={timeLeft < 5000 ? "p-hurry" : ""}>{Math.ceil(timeLeft / 1000)}s</span></div>
              <h2 key={room.prompt.id} className="prompt">{room.prompt.text}</h2>
              {room.myAnswer?.final || room.myAnswer?.pending ? (
                <div className={room.myAnswer.pending ? "p-locked checking" : "p-locked"}>
                  {room.myAnswer.answer ? <>Locked in: <b>“{room.myAnswer.answer}”</b></> : <>No answer this round.</>}
                  {room.myAnswer.pending
                    ? <span className="muted"> · <span className="dot" /> mission control is checking…</span>
                    : <span className="muted"> · waiting for {room.players.filter((p) => !p.done).length} more…</span>}
                </div>
              ) : (
                <>
                  <form className="row" onSubmit={(e) => { e.preventDefault(); void answer(); }}>
                    <input ref={inputRef} value={draft} onChange={(e) => setDraft(e.target.value)} maxLength={60} placeholder="something nobody else will say…" aria-label="Your answer" autoComplete="off" spellCheck={false} disabled={!!busy} />
                    <button type="submit" disabled={!!busy || !draft.trim()}>LOCK IN</button>
                  </form>
                  <div className="row small-actions"><span className="muted small">{sdLive ? "No retries. No edits. Make it rare." : room.myAnswer?.tries ? `${3 - room.myAnswer.tries} tries left` : "3 tries · fast answers earn up to +20"}</span><button className="link" onClick={() => answer(true)} disabled={!!busy}>pass</button></div>
                </>
              )}
              {quickCrash ? <CrashCard text={quickCrash.text} kind={quickCrash.kind} seed={quickCrash.seed} /> : room.myAnswer?.rejected && !room.myAnswer.pending && (
                <CrashCard seed={room.myAnswer.tries} kind={room.myAnswer.failKind} out={room.myAnswer.final}
                  text={`${room.myAnswer.rejected} ${room.myAnswer.final ? "No fuel left this round." : `${3 - room.myAnswer.tries} ${3 - room.myAnswer.tries === 1 ? "try" : "tries"} left.`}`} />
              )}
              {feedback && <p className="err">{feedback}</p>}
              <ul className="p-status">{room.players.map((p) => <li key={p.pid} className={p.done ? "done" : ""} title={p.name}><span>{p.avatar}</span><small>{p.done ? "✓" : "…"}</small></li>)}</ul>
              {isHost && <div className="p-hostbar"><button className="link" onClick={() => act("end-round")} disabled={!!busy}><Icon name="clock" size={14} /> End round now</button></div>}
              {serverNow - room.startsAt < 800 && <div className="p-go" aria-hidden="true">GO!</div>}
            </div>
          )
        )}

        {/* ---------- reveal ---------- */}
        {room?.you && room.phase === "reveal" && lastResult?.sd && room.sd && (
          <div>
            <SdReveal room={room} result={lastResult} byPid={byPid} />
            <Standings room={room} />
            <div className="row wrap">
              {isHost || serverNow - room.revealAt > room.takeoverMs
                ? <button onClick={() => act("next")} disabled={!!busy} autoFocus>SEE THE PODIUM ▲</button>
                : <p className="muted small">Waiting for the host… (anyone can continue in {Math.max(0, Math.ceil((room.takeoverMs - (serverNow - room.revealAt)) / 1000))}s)</p>}
            </div>
            <Chat room={room} send={(text) => act("chat", { text })} />
          </div>
        )}
        {room?.you && room.phase === "reveal" && lastResult && !lastResult.sd && (
          <div>
            <div className="rnd"><span>ROUND {room.round + 1} OF {room.totalRounds} · RESULTS</span></div>
            <p className="ptext">{lastResult.prompt}</p>
            <ul className="p-answers">
              {[...lastResult.rows].sort((a, b) => b.points - a.points).map((r, i) => {
                const p = byPid.get(r.pid);
                return (
                  <li key={r.pid} className={`${r.tier ?? "miss"}${r.jinx ? " jinx" : ""}${r.pid === room.you ? " you" : ""}`} style={{ animationDelay: `${i * 0.12}s`, ["--tc" as string]: r.tier ? `var(--${r.tier})` : "var(--miss)" }}>
                    <span className="p-big">{p?.avatar ?? "👻"}</span>
                    <div className="p-ans-main">
                      <div><b>{r.answer ? `“${r.answer}”` : "—"}</b> <span className="muted small">{p?.name ?? "left"}</span></div>
                      <div className="p-tags">
                        {r.tier && <span className="tag t">{TIER_NAMES[r.tier]} {r.jinx ? `${r.base * r.jinx}÷${r.jinx}` : r.base}</span>}
                        {r.jinx > 0 && <span className="tag j">JINX ×{r.jinx}</span>}
                        {r.only > 0 && <span className="tag o">ONLY YOU +{r.only}</span>}
                        {r.repeat ? <span className="tag rep" title="Room DNA: you've said this in front of someone here before">SAID IT BEFORE −{r.repeat}</span> : null}
                        {r.speed > 0 && <span className="tag s">⚡+{r.speed}</span>}
                        {r.tier === "t1" && !r.jinx && <span className="tag basic">BASIC</span>}
                        {r.tier === "t5" && <span className="tag brain">GALAXY BRAIN</span>}
                        {r.unverified && <span className="tag u" title="The AI judge was too busy to check this in time, so it was taken on trust and scored at the lowest tier">ON TRUST</span>}
                        {!r.tier && <span className="muted small">{r.quip}</span>}
                      </div>
                      {r.fails?.length ? <div className="bloopers">{r.fails.map((f, k) => <span key={k} title={f.why}><s>{f.text}</s></span>)}</div> : null}
                    </div>
                    <span className="p-pts">+<CountUp to={r.points} delay={i * 120 + 350} /></span>
                  </li>
                );
              })}
            </ul>
            <Standings room={room} />
            <div className="row wrap">
              {isHost || serverNow - room.revealAt > room.takeoverMs
                ? <button className={room.round + 1 >= room.totalRounds && room.canSudden ? "sd-btn" : undefined} onClick={() => act("next")} disabled={!!busy} autoFocus>{room.round + 1 >= room.totalRounds ? (room.canSudden ? "⚔️ SUDDEN DEATH ▲" : "SEE THE PODIUM ▲") : "NEXT PROMPT ▲"}</button>
                : <p className="muted small">Waiting for the host… (anyone can continue in {Math.max(0, Math.ceil((room.takeoverMs - (serverNow - room.revealAt)) / 1000))}s)</p>}
              {isHost && room.round + 1 < room.totalRounds && <button className="link" onClick={() => act("end-game")} disabled={!!busy}><Icon name="flag" size={14} /> End game here</button>}
            </div>
            <Chat room={room} send={(text) => act("chat", { text })} />
          </div>
        )}

        {/* ---------- final ---------- */}
        {room?.you && room.phase === "final" && (
          <div>
            <h2 className="p-final-title">Mission complete</h2>
            <Podium room={room} />
            <Awards room={room} />
            {room.settings.dna !== false && <RoomDna room={room} byPid={byPid} />}
            <Standings room={room} final />
            <HallOfShame room={room} byPid={byPid} />
            <Recap room={room} byPid={byPid} />
            <div className="row wrap">
              {isHost ? <button onClick={() => act("again", {}, "Refuelling…")} disabled={!!busy}>PLAY AGAIN ▲</button> : <p className="muted small">The host can start another game with the same crew.</p>}
              <button className="ghost" onClick={shareResult}>{copied ? "COPIED ✓" : "COPY RESULTS"}</button>
              <button className="ghost" onClick={leave}>LEAVE</button>
            </div>
            <Chat room={room} send={(text) => act("chat", { text })} />
          </div>
        )}

        {room?.you && (
          <div className="p-react" aria-label="Send a reaction">
            {REACTIONS.map((e) => <button key={e} onClick={() => { void api("/api/party", { action: "react", code, emoji: e }).then((r) => apply(r as View)).catch(() => {}); }}>{e}</button>)}
          </div>
        )}
      </section>
    </main>
  );
}

// ------------------------------------------------------------------ pieces
function Standings({ room, final }: { room: View; final?: boolean }) {
  const last = room.results[room.results.length - 1];
  const gained = new Map(last?.rows.map((r) => [r.pid, r.points]) ?? []);
  const sorted = [...room.players].sort((a, b) => b.score - a.score);
  // rank = how many players are strictly ahead, so ties share a rank
  const prev = (p: Player) => p.score - (gained.get(p.pid) ?? 0);
  const rankBefore = (p: Player) => room.players.filter((q) => prev(q) > prev(p)).length;
  const rankNow = (p: Player) => room.players.filter((q) => q.score > p.score).length;
  const top = Math.max(1, sorted[0]?.score ?? 1);
  return (
    <ol className="p-race">
      {sorted.map((p, i) => {
        const moved = final || room.results.length < 2 ? 0 : rankBefore(p) - rankNow(p);
        return (
          <li key={p.pid} className={p.pid === room.you ? "you" : ""}>
            <span className="p-rank">{rankNow(p) + 1}{moved > 0 ? <em className="up">▲{moved}</em> : moved < 0 ? <em className="down">▼{-moved}</em> : null}</span>
            <span className="p-name">{p.name}</span>
            <span className="p-track"><span className="p-rocket" style={{ left: `calc(${(p.score / top) * 100}% - ${(p.score / top) * 1.4}em)` }}>{p.avatar}</span></span>
            <b><CountUp to={p.score} from={prev(p)} delay={400} /></b>
          </li>
        );
      })}
    </ol>
  );
}

function Podium({ room }: { room: View }) {
  const top = [...room.players].sort((a, b) => b.score - a.score).slice(0, 3);
  const order = [top[1], top[0], top[2]];
  return (
    <div className="p-podium">
      {order.map((p, i) => p && (
        <div key={p.pid} className={`p-step s${i}`} style={{ animationDelay: `${[0.5, 0.9, 0.2][i]}s` }}>
          {i === 1 && <span className="p-crown"><Icon name="crown" size={22} /></span>}<span className="p-big">{p.avatar}</span><b>{p.name}</b><span className="muted small"><CountUp to={p.score} delay={[500, 900, 200][i] + 300} /> pts</span>
          <div className="p-block"><span>{[2, 1, 3][i]}</span></div>
        </div>
      ))}
    </div>
  );
}

function Awards({ room }: { room: View }) {
  const tally = (f: (r: Row) => number) => {
    const m = new Map<string, number>();
    for (const res of room.results) for (const r of res.rows) m.set(r.pid, (m.get(r.pid) ?? 0) + f(r));
    let best: [string, number] | null = null;
    for (const e of m) if (e[1] > 0 && (!best || e[1] > best[1])) best = e;
    return best;
  };
  const rank = (r: Row) => (r.tier ? Number(r.tier[1]) * 1000 + r.base : 0);
  let rarest: Row | null = null;
  for (const res of room.results) for (const r of res.rows) if (r.tier && (!rarest || rank(r) > rank(rarest))) rarest = r;
  const name = (pid: string) => { const p = room.players.find((x) => x.pid === pid); return p ? `${p.avatar} ${p.name}` : "someone who left"; };
  const awards: [string, string, string][] = [];
  const sdRes = room.results.find((r) => r.sd);
  if (room.sd?.done && sdRes) {
    const w = room.sd.winner, wr = sdRes.rows.find((r) => r.pid === w);
    awards.push(["⚔️", w ? "Sudden Death champion" : "Sudden Death draw", w ? `${name(w)} · “${wr?.answer ?? "—"}” for +${wr?.points ?? 0}` : room.sd.finalists.map(name).join(" and ") + " couldn't be split"]);
  }
  const orig = tally((r) => (r.only ? 1 : 0)); if (orig) awards.push(["🦄", "Most original", `${name(orig[0])} · ${orig[1]} ${orig[1] === 1 ? "answer" : "answers"} nobody else said`]);
  if (rarest) awards.push(["💎", "Rarest answer", `${name(rarest.pid)} · “${rarest.answer}” (${TIER_NAMES[rarest.tier!]})`]);
  const fast = tally((r) => r.speed); if (fast) awards.push(["⚡", "Fastest fingers", `${name(fast[0])} · +${fast[1]} speed points`]);
  const jinx = tally((r) => (r.jinx ? 1 : 0)); if (jinx) awards.push(["🤝", "Jinx magnet", `${name(jinx[0])} · matched someone ${jinx[1] === 1 ? "once" : `${jinx[1]} times`}`]);
  const crash = tally((r) => (r.tier ? 0 : 1)); if (crash && crash[1] >= 2) awards.push(["💥", "Crash test dummy", `${name(crash[0])} · ${crash[1]} misses`]);
  const blooper = tally((r) => r.fails?.length ?? 0);
  if (blooper) { const worst = room.results.flatMap((res) => res.rows).filter((r) => r.pid === blooper[0]).flatMap((r) => r.fails ?? []).at(-1);
    awards.push(["🤡", "Blooper of the game", `${name(blooper[0])} · ${blooper[1]} rejected${worst ? `, incl. “${worst.text}”` : ""}`]); }
  const basic = tally((r) => (r.tier === "t1" ? 1 : 0)); if (basic && basic[1] >= 2) awards.push(["🥱", "Most basic", `${name(basic[0])} · ${basic[1]} answers everyone saw coming`]);
  if (!awards.length) return null;
  return <ul className="p-awards">{awards.map(([e, t, d], i) => <li key={t} style={{ animationDelay: `${1.2 + i * 0.15}s` }}><span className="p-medal">{e}</span><div><b>{t}</b><small>{d}</small></div></li>)}</ul>;
}

function Reactions({ room, serverNow, byPid }: { room: View | null; serverNow: number; byPid: Map<string, Player> }) {
  if (!room) return null;
  const live = room.reactions.filter((r) => serverNow - r.at < 3500);
  return (
    <div className="p-floats" aria-hidden="true">
      {live.map((r) => (
        <span key={r.id} style={{ left: `${8 + ((r.id * 37) % 84)}%` }}>{r.e}<small>{byPid.get(r.pid)?.name ?? ""}</small></span>
      ))}
    </div>
  );
}

function Confetti() {
  const bits = useMemo(() => Array.from({ length: 90 }, (_, i) => ({
    left: Math.random() * 100, delay: Math.random() * 2.5, dur: 2.8 + Math.random() * 2.4, rot: Math.random() * 360,
    color: ["var(--t2)", "var(--t3)", "var(--t4)", "var(--t5)", "#fff"][i % 5], w: 6 + Math.random() * 6,
  })), []);
  return <div className="p-confetti" aria-hidden="true">{bits.map((b, i) => <i key={i} style={{ left: `${b.left}%`, animationDelay: `${b.delay}s`, animationDuration: `${b.dur}s`, background: b.color, width: b.w, transform: `rotate(${b.rot}deg)` }} />)}</div>;
}

// ------------------------------------------------------------------ Room DNA
/** Each player's strongest traits, built from every party game they've played. */
function RoomDna({ room, byPid }: { room: View; byPid: Map<string, Player> }) {
  if (!room.dna) return <p className="dna-card loading muted small"><span className="dot" />Sequencing your crew&apos;s DNA…</p>;
  const ids = Object.keys(room.dna);
  if (!ids.length) return null;
  return (
    <div className="dna-card">
      <div className="dna-head"><b>🧬 ROOM DNA</b><small>from every party game you&apos;ve played</small></div>
      <ul>{ids.map((pid, i) => { const d = room.dna![pid], p = byPid.get(pid); return (
        <li key={pid} className={pid === room.you ? "you" : ""} style={{ animationDelay: `${1.4 + i * 0.12}s` }}>
          <span className="p-big">{p?.avatar ?? "👻"}</span>
          <div className="dna-main">
            <div className="dna-name"><b>{p?.name ?? "left"}</b><small>{d.games} game{d.games === 1 ? "" : "s"} · {d.answers} answers{d.repeats ? ` · ${d.repeats} repeat${d.repeats === 1 ? "" : "s"} today` : ""}</small></div>
            {d.traits.map((t, k) => (
              <div key={t.id} className="dna-trait"><span>{t.e} {t.name}</span><span className="bar"><i style={{ width: `${t.pct}%`, animationDelay: `${1.6 + i * 0.12 + k * 0.1}s` }} /></span><span className="pc">{t.pct}%</span></div>
            ))}
          </div>
        </li>
      ); })}</ul>
    </div>
  );
}

// ------------------------------------------------------------------ Sudden Death
/** The face-off card during the countdown: two rockets, VS, and the rules. */
function SdIntro({ room, countdown, byPid }: { room: View; countdown: number; byPid: Map<string, Player> }) {
  const [a, b] = room.sd!.finalists.map((pid) => byPid.get(pid));
  return (
    <div className="sd-intro">
      <small className="sd-kicker">THE FINAL {room.sdSeconds} SECONDS</small>
      <h2 className="sd-title">SUDDEN DEATH</h2>
      <div className="sd-vs">
        <div className="sd-side l"><span className="p-big">{a?.avatar ?? "👻"}</span><b>{a?.name ?? "left"}</b><small>{a?.score ?? 0} pts</small></div>
        <div className="sd-x">VS</div>
        <div className="sd-side r"><span className="p-big">{b?.avatar ?? "👻"}</span><b>{b?.name ?? "left"}</b><small>{b?.score ?? 0} pts</small></div>
      </div>
      <div key={countdown} className="p-countdown sd-count">{countdown}</div>
      <p className="muted small">One prompt · {room.sdSeconds} seconds · one shot, no retries · rarity points ×2</p>
    </div>
  );
}

/** What everyone else sees while the finalists answer. */
function SdWatch({ room, byPid, timeLeft }: { room: View; byPid: Map<string, Player>; timeLeft: number }) {
  return (
    <div className="sd-watch">
      <div className="rnd"><span><b className="sd-tag">⚔️ SUDDEN DEATH</b></span><span className={timeLeft < 5000 ? "p-hurry" : ""}>{Math.ceil(timeLeft / 1000)}s</span></div>
      <h2 className="prompt">{room.prompt?.text}</h2>
      <div className="sd-vs small">
        {room.sd!.finalists.map((pid, i) => { const p = byPid.get(pid); return (
          <div key={pid} className={`sd-side ${i ? "r" : "l"}${p?.done ? " locked" : ""}`}><span className="p-big">{p?.avatar ?? "👻"}</span><b>{p?.name ?? "left"}</b><small>{p?.done ? "LOCKED IN ✓" : "thinking…"}</small></div>
        ); })}
      </div>
      <p className="muted small">You're watching the final. Answers reveal together when both lock in.</p>
    </div>
  );
}

/** Both answers flip over at once, then the winner is crowned. */
function SdReveal({ room, result, byPid }: { room: View; result: { prompt: string; rows: Row[] }; byPid: Map<string, Player> }) {
  const w = room.sd!.winner;
  return (
    <div className="sd-reveal">
      <small className="sd-kicker">SUDDEN DEATH · RESULTS</small>
      <p className="ptext">{result.prompt}</p>
      <div className="sd-vs">
        {room.sd!.finalists.map((pid, i) => {
          const p = byPid.get(pid), r = result.rows.find((x) => x.pid === pid);
          return (
            <div key={pid} className={`sd-card ${i ? "r" : "l"}${w === pid ? " win" : w ? " lose" : ""}`} style={{ ["--tc" as string]: r?.tier ? `var(--${r.tier})` : "var(--miss)" }}>
              <div className="sd-flip"><div className="sd-front">?</div>
                <div className="sd-back">
                  <span className="p-big">{p?.avatar ?? "👻"}</span><b>{p?.name ?? "left"}</b>
                  <div className="sd-ans">{r?.answer ? `“${r.answer}”` : "—"}</div>
                  <small>{r?.tier ? TIER_NAMES[r.tier] : "NO ANSWER"}{r?.jinx ? " · JINX" : ""}</small>
                  <span className="sd-pts">+<CountUp to={r?.points ?? 0} delay={1500} /></span>
                </div>
              </div>
              {w === pid && <div className="sd-crown"><Icon name="crown" size={26} /><span>CHAMPION</span></div>}
            </div>
          );
        })}
      </div>
      {!w && <p className="sd-draw">A perfect draw. The universe couldn&apos;t pick.</p>}
    </div>
  );
}

// ------------------------------------------------------------------ extra pieces
/** Animates a number from `from` up to `to`. */
function CountUp({ to, from = 0, delay = 0, ms = 700 }: { to: number; from?: number; delay?: number; ms?: number }) {
  const [n, setN] = useState(from);
  useEffect(() => {
    if (typeof matchMedia !== "undefined" && matchMedia("(prefers-reduced-motion: reduce)").matches) { setN(to); return; }
    let raf = 0; const t0 = performance.now() + delay;
    const step = (t: number) => {
      const k = Math.min(1, Math.max(0, (t - t0) / ms));
      setN(Math.round(from + (to - from) * (1 - Math.pow(1 - k, 3))));
      if (k < 1) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [to, from, delay, ms]);
  return <>{n}</>;
}

function HostMenu({ name, onHost, onKick }: { name: string; onHost: () => void; onKick: () => void }) {
  const [open, setOpen] = useState(false);
  const [sure, setSure] = useState(false);
  return (
    <span className="p-hm">
      <button className="p-hm-btn" aria-label={`Options for ${name}`} onClick={() => { setOpen(!open); setSure(false); }}>⋯</button>
      {open && (
        <span className="p-hm-menu">
          <button onClick={() => { setOpen(false); onHost(); }}>Make host</button>
          {sure ? <button className="danger" onClick={() => { setOpen(false); onKick(); }}>tap again to remove</button>
                : <button onClick={() => setSure(true)}>Remove from room</button>}
        </span>
      )}
    </span>
  );
}

function Chat({ room, send }: { room: View; send: (text: string) => Promise<unknown> }) {
  const [text, setText] = useState("");
  const [open, setOpen] = useState(true);
  const listRef = useRef<HTMLDivElement>(null);
  const msgs = room.chat;
  const lastId = msgs.length ? msgs[msgs.length - 1].id : 0;
  useEffect(() => { const el = listRef.current; if (el) el.scrollTop = el.scrollHeight; }, [lastId, open]);
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const t = text.trim(); if (!t) return;
    setText(""); await send(t);
  }
  const QUICK = ["gg 🙌", "too easy 😎", "how?! 🤯", "one more! 🔁"];
  return (
    <div className="p-chat">
      <button className="p-chat-head" onClick={() => setOpen(!open)} aria-expanded={open}><span><Icon name="chat" size={14} /> Chat</span><small>{msgs.length ? `${msgs.length} message${msgs.length === 1 ? "" : "s"}` : "say hi"} {open ? "▾" : "▸"}</small></button>
      {open && (
        <>
          <div className="p-chat-list" ref={listRef}>
            {msgs.length === 0 ? <p className="muted small">No messages yet.</p> : msgs.map((m) => (
              <div key={m.id} className={m.pid === room.you ? "p-msg me" : "p-msg"}>
                <span className="p-msg-av">{m.avatar}</span>
                <div><small>{m.pid === room.you ? "you" : m.name}</small><p>{m.text}</p></div>
              </div>
            ))}
          </div>
          <div className="p-quick">{QUICK.map((q) => <button key={q} onClick={() => send(q)}>{q}</button>)}</div>
          <form className="row" onSubmit={submit}>
            <input value={text} onChange={(e) => setText(e.target.value)} maxLength={120} placeholder="Message the room…" aria-label="Chat message" autoComplete="off" />
            <button type="submit" disabled={!text.trim()}>SEND</button>
          </form>
        </>
      )}
    </div>
  );
}

function Recap({ room, byPid }: { room: View; byPid: Map<string, Player> }) {
  const [open, setOpen] = useState(false);
  if (!room.results.length) return null;
  return (
    <div className="p-recap">
      <button className="p-chat-head" onClick={() => setOpen(!open)} aria-expanded={open}><span><Icon name="scroll" size={14} /> Game recap</span><small>{room.results.length} rounds {open ? "▾" : "▸"}</small></button>
      {open && room.results.map((res, i) => (
        <div key={i} className="p-recap-round">
          <small>ROUND {i + 1}</small>
          <b>{res.prompt}</b>
          <ul>{[...res.rows].sort((a, b) => b.points - a.points).map((r) => (
            <li key={r.pid} style={{ ["--tc" as string]: r.tier ? `var(--${r.tier})` : "var(--miss)" }}>
              <span>{byPid.get(r.pid)?.avatar ?? "👻"}</span><span className="p-name">{r.answer ?? "—"}</span>
              {r.only > 0 && <span className="tag o">ONLY YOU</span>}{r.jinx > 0 && <span className="tag j">JINX</span>}
              <b>+{r.points}</b>
            </li>
          ))}</ul>
        </div>
      ))}
    </div>
  );
}

function HallOfShame({ room, byPid }: { room: View; byPid: Map<string, Player> }) {
  const all = room.results.flatMap((res) => res.rows.flatMap((r) => (r.fails ?? []).map((f) => ({ ...f, pid: r.pid, prompt: res.prompt }))));
  if (!all.length) return null;
  return (
    <div className="shame">
      <h3>Hall of Shame <small>{all.length} rejected answer{all.length === 1 ? "" : "s"}</small></h3>
      <ul>{all.slice(-8).map((f, i) => (
        <li key={i} style={{ animationDelay: `${1.6 + i * 0.12}s` }}>
          <span className="shame-av">{byPid.get(f.pid)?.avatar ?? "👻"}</span>
          <div><b>“{f.text}”</b><small>for “{f.prompt}”</small><em>{f.why}</em></div>
        </li>
      ))}</ul>
    </div>
  );
}
