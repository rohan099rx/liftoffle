"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import Sky, { altFor, fmtKm, SIGHTS, zoneFor } from "./Sky";
import { api, beep } from "./client";
import { dailyReward, levelFor, MAX_BOOSTS, type Level } from "@/lib/progress";
import { Icon } from "./icons";
import { BadgeGrid, BadgeToasts, fredSays, syncBadges, unlock } from "./achievements";
import { BASIC_LINES, CHICKEN_LINES, CrashCard, isMash, MASH_LINES, OUT_OF_FUEL, pick, REPEAT_LINES, sfx, Stamp } from "./fun";

// ------------------------------------------------------------------ types & helpers
type Prompt = { id: string; text: string; category: string };
type Result = { answer: string | null; tier: string | null; score: number; share?: number; quip?: string; hint: boolean; receipt: string; skipped?: boolean; fail?: string };
type Run = { runId: string; mode: "daily" | "endless"; category: string; date: string; dayNumber: number; prompts: Prompt[]; results: Result[] };
type Stats = { played: number; best: number; total: number; tiers: Record<string, number>; history: { d: string; s: number }[] };
type Curio = { fact: string | null; top: { name: string; pct: number } | null; deep: { name: string; pct: number } | null; place: number | null; listed: number; crowd?: { name: string; pct: number }[] };
type ServerProfile = {
  profile: { played: number; best: number; total: number; tiers: Record<string, number>; categories: Record<string, number>; attempts: number; accepted: number; rejected: number; skipped: number; hints: number;
    rarest: { answer: string; prompt: string; share: number } | null; badges: Record<string, number>; created: number;
    xp: number; boosts: number; boostsUsed: number; checkin: { last: string; n: number; best: number }; sights?: Record<string, number>;
    legacy?: { played: number; best: number; total: number; tiers: Record<string, number> } };
  runs: { at: number; mode: string; date: string; category: string; score: number; tiers: (string | null)[] }[];
  answers: { at: number; prompt: string; typed: string | null; valid: boolean; answer?: string; tier?: string | null; skipped?: boolean; reason?: string; mode: string }[];
  answerTotal: number;
  level: Level; bonusReady: boolean; allTimeRank: number | null;
};
type Reward = { xpGained: number; xp: number; levelBefore: number; levelAfter: number; boostsEarned: number; boosts: number; newBadges: string[]; counted: boolean };
type Screen = "menu" | "play" | "end" | "board" | "stats" | "how";
type BoardRow = { rank: number; name: string; score: number; grid: string; you: boolean; named: boolean; level?: number };
type BoardDay = "today" | "yesterday" | "week" | "all";
type Board = { date: string; day: BoardDay; players: number; rows: BoardRow[]; me: (Omit<BoardRow, "you"> & { inTop: boolean }) | null; myName: string | null };

const TIER_NAMES: Record<string, string> = { t1: "GROUND CREW", t2: "PILOT", t3: "ASTRONAUT", t4: "VOYAGER", t5: "LIGHT-YEAR" };
const EMOJI: Record<string, string> = { t1: "⬜", t2: "🟦", t3: "🟩", t4: "🟨", t5: "🟪", miss: "⬛" };
const CATS = ["anything", "space", "nature", "food", "music", "geography", "movies & tv", "science", "sports", "history", "games"];
const EMPTY_STATS: Stats = { played: 0, best: 0, total: 0, tiers: {}, history: [] };

const ls = {
  get<T>(k: string, d: T): T { try { const v = localStorage.getItem(k); return v ? (JSON.parse(v) as T) : d; } catch { return d; } },
  set(k: string, v: unknown) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* storage may be blocked */ } },
};

// ------------------------------------------------------------------ component
export default function Home() {
  const [screen, setScreen] = useState<Screen>("menu");
  const [run, setRun] = useState<Run | null>(null);
  const [today, setToday] = useState<{ date: string; dayNumber: number; resetsAt: string; mock: boolean } | null>(null);
  const [category, setCategory] = useState("anything");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [msg, setMsg] = useState<string | null>(null);
  const [triesLeft, setTriesLeft] = useState<number | null>(null);
  const [hint, setHint] = useState<string | null>(null);
  const [reveal, setReveal] = useState<{ total: number; answers: { answer: string; pct: number }[] } | null>(null);
  const [finish, setFinish] = useState<any>(null);
  const [board, setBoard] = useState<Board | null>(null);
  const [boardDay, setBoardDay] = useState<BoardDay>("today");
  const [preview, setPreview] = useState<Board | null>(null);
  const [stats, setStats] = useState<Stats>(EMPTY_STATS);
  const [prof, setProf] = useState<ServerProfile | null>(null);
  const [curio, setCurio] = useState<Curio | null>(null);
  const [bonus, setBonus] = useState<{ gained: number; streak: number; label: string } | null>(null);
  const [boosted, setBoosted] = useState(false);
  const [analysis, setAnalysis] = useState<{ title: string; text: string } | null>(null);
  const [sharing, setSharing] = useState(false);
  // Sky Log: things spotted on the way up
  const [sights, setSights] = useState<Record<string, number>>({});
  const [spot, setSpot] = useState<{ id: string; fresh: boolean; k: number } | null>(null);
  const spotQueue = useRef<string[]>([]);
  const onSpot = useCallback((id: string) => {
    const fresh = !ls.get<Record<string, number>>("lo:sights", {})[id];
    if (fresh) {
      const all = { ...ls.get<Record<string, number>>("lo:sights", {}), [id]: Date.now() };
      ls.set("lo:sights", all); setSights(all);
      spotQueue.current.push(id);
      if (Object.keys(all).length >= 12) unlock("sky_spotter");
      if (id === "jupiter") unlock("jupiter");
    }
    const k = Date.now(); setSpot({ id, fresh, k });
    setTimeout(() => setSpot((s) => (s?.k === k ? null : s)), 2600);
  }, []);
  // send new sightings to the server in small batches
  useEffect(() => {
    const t = setInterval(() => {
      if (!spotQueue.current.length) return;
      const batch = spotQueue.current.splice(0);
      void api("/api/profile", { sights: batch }).catch(() => { spotQueue.current.push(...batch); });
    }, 4000);
    return () => clearInterval(t);
  }, []);
  // flight replay on the results screen: the rocket climbs again from the pad through everything it passed
  const [replay, setReplay] = useState<number | null>(null);
  const replayTimer = useRef<ReturnType<typeof setInterval> | null>(null);
  const stopReplay = useCallback(() => { if (replayTimer.current) clearInterval(replayTimer.current); replayTimer.current = null; setReplay(null); }, []);
  const startReplay = useCallback((to: number) => {
    if (replayTimer.current) clearInterval(replayTimer.current);
    if (matchMedia("(prefers-reduced-motion: reduce)").matches || to <= 0) return;
    const ms = Math.min(11000, 3500 + to * 11), t0 = performance.now() + 1600; // drop back to the pad first, then climb
    setReplay(0);
    replayTimer.current = setInterval(() => {
      const k = Math.max(0, Math.min(1, (performance.now() - t0) / ms));
      const eased = k < 0.5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2;
      setReplay(Math.round(to * eased * 10) / 10);
      if (k >= 1) { clearInterval(replayTimer.current!); replayTimer.current = null; setTimeout(() => setReplay(null), 1200); }
    }, 90);
  }, []);
  const refreshProfile = useCallback(() => api<ServerProfile>("/api/profile").then(setProf).catch(() => {}), []);
  const [nick, setNick] = useState("");
  const [sound, setSound] = useState(true);
  const [boostKey, setBoostKey] = useState(0);
  const [boostTier, setBoostTier] = useState<string | null>(null);
  const [alt, setAlt] = useState(0);
  const [copied, setCopied] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const [crash, setCrash] = useState<{ text: string; kind?: string; seed: number } | null>(null);
  const tried = useRef<Set<string>>(new Set()); // answers already refused this prompt
  const [crashKey, setCrashKey] = useState(0);
  const [fred, setFred] = useState<{ text: string; k: number } | null>(null);
  const streak = useRef({ crashes: 0, hits: 0, basics: 0, promptRejects: 0 });
  const [hot, setHot] = useState(0);
  const say = (text: string | null) => { if (!text) return; const k = Date.now(); setFred({ text, k }); setTimeout(() => setFred((f) => (f?.k === k ? null : f)), 5200); };

  const score = run ? run.results.reduce((s, r) => s + r.score, 0) : 0;
  const round = run ? run.results.length : 0;
  const current = run && round < run.prompts.length ? run.prompts[round] : null;
  const last = run?.results[round - 1];
  const showingResult = run !== null && screen === "play" && last !== undefined && (round === run.prompts.length || (msg === "__result__"));

  // ---- boot: load prefs, stats, today's info and any unfinished daily run
  useEffect(() => {
    setStats(ls.get("lo:stats", EMPTY_STATS));
    setSights(ls.get("lo:sights", {}));
    setNick(ls.get("lo:nick", ""));
    setSound(ls.get("lo:sound", true));
    // keep retrying instead of leaving a dead menu that only a reload would fix
    let stop = false, delay = 1000;
    const load = () => api("/api/today", undefined, 8000).then((t) => {
      if (stop) return;
      setToday(t); setError(null);
      const saved = ls.get<Run | null>("lo:daily", null);
      if (saved && saved.date === t.date) setRun(saved);
    }).catch(() => {
      if (stop) return;
      setError("Connecting to mission control…");
      setTimeout(load, delay); delay = Math.min(8000, delay * 2);
    });
    void load();
    // the server's copy of your board name wins; an older name only kept in this browser gets uploaded
    api<{ name: string | null }>("/api/nickname").then((r) => {
      if (stop) return;
      const local = ls.get("lo:nick", "");
      if (r.name) { setNick(r.name); ls.set("lo:nick", r.name); }
      else if (local.trim().length >= 2) void api("/api/nickname", { nickname: local }).catch(() => {});
    }).catch(() => {});
    // your profile lives on the server now; bring over what this browser kept before (once)
    api<ServerProfile>("/api/profile").then(async (sp) => {
      if (stop) return;
      sp.profile.badges = syncBadges(sp.profile.badges ?? {});
      // merge the Sky Log both ways
      const localS = ls.get<Record<string, number>>("lo:sights", {}), serverS = sp.profile.sights ?? {};
      const mergedS = { ...serverS, ...localS }; ls.set("lo:sights", mergedS); setSights(mergedS);
      const missingS = Object.keys(localS).filter((k) => !serverS[k]);
      if (missingS.length) void api("/api/profile", { sights: missingS }).catch(() => {});
      const local = ls.get<Stats>("lo:stats", EMPTY_STATS);
      if (!sp.profile.legacy && local.played > 0 && !ls.get("lo:legacy-sent", false)) {
        await api("/api/profile", { legacy: local }).then(() => ls.set("lo:legacy-sent", true)).catch(() => {});
        sp = await api<ServerProfile>("/api/profile").catch(() => sp);
      }
      setProf(sp);
    }).catch(() => {});
    const retry = () => { if (!stop) { delay = 1000; void load(); } };
    addEventListener("online", retry);
    return () => { stop = true; removeEventListener("online", retry); };
  }, []);

  useEffect(() => { if (run?.mode === "daily") ls.set("lo:daily", run); }, [run]);
  const loadPreview = useCallback(() => { api<Board>("/api/leaderboard").then(setPreview).catch(() => {}); }, []);
  useEffect(() => { if (screen === "menu") loadPreview(); }, [screen, loadPreview]);
  useEffect(() => { if (screen === "play" && current && msg !== "__result__") inputRef.current?.focus(); }, [screen, current, msg]);

  const play = useCallback((f: number[]) => { if (sound) beep(f); }, [sound]);

  // ---- starting runs
  async function startDaily() {
    setError(null);
    const saved = run?.mode === "daily" && run.date === today?.date ? run : ls.get<Run | null>("lo:daily", null);
    if (saved && saved.date === today?.date) {
      const done = saved.results.length >= saved.prompts.length;
      setRun(saved); resetRound(); setScreen(done ? "end" : "play");
      if (done) void complete(saved);
      return;
    }
    await start("daily", "anything");
  }
  async function start(mode: "daily" | "endless", cat: string) {
    setBusy(mode === "endless" ? "Writing fresh prompts…" : "Fueling up…"); setError(null);
    try {
      const r = await api<Omit<Run, "results">>("/api/run", { mode, category: cat });
      setRun({ ...r, results: [] }); resetRound(); setFinish(null); setScreen("play"); play([392, 523]);
      streak.current = { crashes: 0, hits: 0, basics: 0, promptRejects: 0 }; setHot(0); setFred(null);
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(null); }
  }
  function resetRound() { setBoosted(false); setCurio(null); setDraft(""); setMsg(null); setTriesLeft(null); setHint(null); setReveal(null); setCrash(null); tried.current = new Set(); streak.current.promptRejects = 0; }

  // ---- answering
  async function submit(skip = false) {
    if (!run || !current || busy) return;
    const answer = draft.trim();
    if (!skip && !answer) return;
    const norm = answer.toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
    // instant comebacks that don't cost a try
    if (new Date().getHours() < 5) unlock("night_owl");
    if (!skip && isMash(answer)) { setCrash({ text: pick(MASH_LINES), kind: "gibberish", seed: Date.now() }); setCrashKey((k) => k + 1); unlock("cat_keyboard"); if (sound) sfx.boing(); inputRef.current?.select(); return; }
    if (!skip && tried.current.has(norm)) { setCrash({ text: pick(REPEAT_LINES), kind: "joke", seed: Date.now() }); unlock("broken_record"); if (sound) sfx.boing(); inputRef.current?.select(); return; }
    setBusy("Checking with mission control…"); setMsg(null);
    try {
      const r = await api("/api/submit", { runId: run.runId, round, answer, skip });
      if (!r.final) {
        tried.current.add(norm);
        setCrash({ text: r.reason, kind: r.fail, seed: Date.now() }); setTriesLeft(r.triesLeft ?? null); setCrashKey((k) => k + 1);
        const st = streak.current; st.crashes++; st.promptRejects++; st.hits = 0; setHot(0);
        say(fredSays({ crashes: st.crashes, hits: 0, basics: st.basics, tier: null }));
        if (sound) sfx.trombone(); inputRef.current?.select(); return;
      }
      setCrash(null);
      if (r.accepted && r.receipt) void api<Curio>("/api/curio", { receipt: r.receipt }, 12000).then(setCurio).catch(() => {});
      const quip = skip ? pick(CHICKEN_LINES) : !r.tier ? `${r.reason ?? ""} ${pick(OUT_OF_FUEL)}`.trim() : r.tier === "t1" ? `${r.quip ?? ""} ${pick(BASIC_LINES)}`.trim() : r.quip;
      const res: Result = { answer: r.answer ?? null, tier: r.tier ?? null, score: r.score, share: r.share, quip, hint: Boolean(r.hint), receipt: r.receipt, skipped: skip, fail: r.fail };
      setRun({ ...run, results: [...run.results, res] });
      // streaks, Fred and achievements
      const st = streak.current, all = [...run.results, res];
      if (res.tier) {
        if (st.promptRejects === 2) unlock("comeback");
        st.crashes = 0; st.hits = res.tier >= "t3" ? st.hits + 1 : 0; st.basics = res.tier === "t1" ? st.basics + 1 : 0;
        if (res.tier === "t5") unlock("galaxy_brain");
        if (st.hits >= 3) unlock("hot_streak");
      } else {
        st.hits = 0; st.basics = 0;
        if (!skip) { st.crashes++; setCrashKey((k) => k + 1); if (st.promptRejects >= 2) unlock("crash_dummy"); }
      }
      if (all.filter((x) => x.skipped).length >= 3) unlock("chicken");
      if (all.filter((x) => x.tier === "t1").length >= 3) unlock("captain_obvious");
      setHot(st.hits);
      say(fredSays({ crashes: res.tier || skip ? 0 : st.crashes, hits: st.hits, basics: st.basics, tier: res.tier, hint: res.hint, skip: skip && Math.random() < 0.6, rarestEver: r.personal?.rarestEver ? r.answer : undefined }));
      setMsg("__result__"); setReveal(null);
      if (res.tier) {
        setBoostTier(res.tier); setBoostKey((k) => k + 1);
        if (!sound) {} else if (res.tier === "t5") sfx.brain(); else if (res.tier === "t1") sfx.yawn(); else play(res.tier >= "t4" ? [523, 659, 784, 1047] : res.tier >= "t3" ? [523, 659, 784] : [440, 523]);
      } else if (sound) { if (skip) sfx.cluck(); else sfx.trombone(); }
    } catch (e) {
      const err = e as Error & { status?: number };
      if (err.status === 404) { setError("That launch expired. Start a new one."); setScreen("menu"); setRun(null); }
      else setMsg(err.message);
    } finally { setBusy(null); }
  }
  async function getHint(boost = false) {
    if (!run || hint || busy) return;
    setBusy(boost ? "Burning a boost…" : "Asking the navigator…");
    try {
      const r = await api("/api/hint", { runId: run.runId, round, boost });
      setHint(r.hint); setBoosted(Boolean(r.boosted));
      if (r.boosted) { play([660, 880, 1175]); setProf((p) => p && { ...p, profile: { ...p.profile, boosts: Math.max(0, p.profile.boosts - 1) } }); }
    }
    catch (e) { setMsg((e as Error).message); }
    finally { setBusy(null); }
  }
  async function claimBonus() {
    if (busy) return;
    try {
      const r = await api<{ ok: boolean; streak: number; boosts: number; gained: number; label: string; newBadges: string[] }>("/api/profile", { claim: true });
      if (r.ok) { setBonus({ gained: r.gained, streak: r.streak, label: r.label }); if (sound) beep([523, 659, 784, 1047, 1319], 0.08); r.newBadges.forEach(unlock); setTimeout(() => setBonus(null), 4500); }
      void refreshProfile();
    } catch (e) { setError((e as Error).message); }
  }
  async function showReveal() {
    if (!last) return;
    try { setReveal(await api("/api/reveal", { receipt: last.receipt })); } catch (e) { setMsg((e as Error).message); }
  }
  function next() {
    if (!run) return;
    resetRound();
    if (run.results.length >= run.prompts.length) { setScreen("end"); void complete(run); startReplay(run.results.reduce((a, x) => a + x.score, 0)); }
  }

  // ---- finishing
  async function complete(r: Run) {
    setFinish({ pending: true });
    try {
      const f = await api("/api/complete", { runId: r.runId, receipts: r.results.map((x) => x.receipt), nickname: nick || undefined });
      setFinish(f); loadPreview();
      setAnalysis(null);
      void api<{ title: string; text: string }>("/api/analysis", { runId: r.runId, receipts: r.results.map((x) => x.receipt) }, 15000).then(setAnalysis).catch(() => {});
      (f.reward?.newBadges ?? []).forEach((id: string) => unlock(id));
      if (f.reward && f.reward.levelAfter > f.reward.levelBefore && sound) setTimeout(() => beep([523, 784, 1047, 1568, 2093], 0.1), 600);
      void refreshProfile();
      const sc = r.results.reduce((a, x) => a + x.score, 0);
      unlock("first_flight");
      if (sc >= 400) unlock("moonwalker");
      if (r.results.every((x) => x.tier)) unlock("flawless");
      if ((f.streak ?? 0) >= 3) unlock("three_peat");
      const key = `lo:counted:${r.runId}`;
      if (!ls.get(key, false)) {
        ls.set(key, true);
        const s = ls.get<Stats>("lo:stats", EMPTY_STATS);
        const sc = r.results.reduce((a, x) => a + x.score, 0);
        const tiers = { ...s.tiers };
        for (const x of r.results) tiers[x.tier ?? "miss"] = (tiers[x.tier ?? "miss"] ?? 0) + 1;
        const ns: Stats = { played: s.played + 1, best: Math.max(s.best, sc), total: s.total + sc, tiers, history: [...s.history, { d: r.mode === "daily" ? r.date : "endless", s: sc }].slice(-30) };
        ls.set("lo:stats", ns); setStats(ns);
      }
    } catch (e) { setFinish({ error: (e as Error).message }); }
  }
  async function loadBoard(day: BoardDay) {
    setBoardDay(day); setBoard(null);
    try { setBoard(await api<Board>(`/api/leaderboard?day=${day}`)); } catch (e) { setError((e as Error).message); }
  }
  function openBoard() { setScreen("board"); void loadBoard("today"); }
  // after a name change, refresh whatever board is on screen so you see it straight away
  const onNameSaved = (n: string) => { setNick(n); ls.set("lo:nick", n); loadPreview(); if (screen === "board") void loadBoard(boardDay); };

  /** A picture of your flight: opens the phone's share sheet with the image, or downloads it on desktop. */
  async function shareImage() {
    if (!run || sharing) return;
    setSharing(true);
    try {
      const blob = await drawShareCard({
        head: run.mode === "daily" ? `DAILY LAUNCH · DAY ${run.dayNumber}` : `ENDLESS · ${run.category.toUpperCase()}`,
        score, km: altFor(score), zone: zoneFor(altFor(score)), tiers: run.results.map((r) => r.tier),
        rank: finish?.rank ? { n: finish.rank, of: finish.players } : null, rare: run.results.filter((r) => r.tier === "t4" || r.tier === "t5").length,
        title: analysis?.title ?? null, url: location.host,
      });
      const file = new File([blob], `liftoffle-${run.mode === "daily" ? `day-${run.dayNumber}` : "flight"}.png`, { type: "image/png" });
      const text = `I flew ${fmtKm(altFor(score))} on Liftoffle. Can you fly higher? ${location.origin}`;
      if (navigator.canShare?.({ files: [file] })) await navigator.share({ files: [file], text });
      else { const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = file.name; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 4000); }
    } catch (e) { if ((e as Error).name !== "AbortError") setMsg("Couldn't make the image. Try copying the text instead."); }
    finally { setSharing(false); }
  }
  async function copyResult() {
    if (!run) return;
    const grid = run.results.map((r) => EMOJI[r.tier ?? "miss"]).join("");
    const head = run.mode === "daily" ? `Liftoffle Day ${run.dayNumber}` : `Liftoffle Endless · ${run.category}`;
    const text = `${head}\n${grid}\n${score} pts · ${fmtKm(altFor(score))}${finish?.rank ? ` · #${finish.rank} today` : ""}\n${location.origin}`;
    try { await navigator.clipboard.writeText(text); setCopied(true); setTimeout(() => setCopied(false), 1800); } catch { setMsg("Copy was blocked by the browser."); }
  }

  // ---- countdown
  useEffect(() => { if (screen !== "end") stopReplay(); }, [screen, stopReplay]);
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(t); }, []);
  const left = today ? Math.max(0, Date.parse(today.resetsAt) - now) : 0;
  const countdown = `${String(Math.floor(left / 36e5)).padStart(2, "0")}:${String(Math.floor((left % 36e5) / 6e4)).padStart(2, "0")}:${String(Math.floor((left % 6e4) / 1e3)).padStart(2, "0")}`;
  const savedDaily = run?.mode === "daily" ? run : (typeof window !== "undefined" ? ls.get<Run | null>("lo:daily", null) : null);
  const dailyMine = savedDaily && savedDaily.date === today?.date ? savedDaily : null;
  const dailyDone = !!dailyMine && dailyMine.results.length >= dailyMine.prompts.length;
  const dailyInProgress = !!dailyMine && !dailyDone && dailyMine.results.length > 0;

  // ------------------------------------------------------------------ render
  return (
    <main>
      <Sky score={replay ?? (screen === "menu" ? 0 : score)} boostKey={boostKey} boostTier={boostTier} crashKey={crashKey} onAlt={setAlt} onSpot={onSpot} />
      {spot && <SpotToast key={spot.k} id={spot.id} fresh={spot.fresh} count={Object.keys(sights).length} />}
      <BadgeToasts sound={sound} />

      <header className="hud">
        <button className="box brand" onClick={() => setScreen("menu")} aria-label="Back to menu"><img className="brand-mark" src="/brand/mark.svg" alt="" />LIFTOFF<span>LE</span>
          <small>{run && screen !== "menu" ? (run.mode === "daily" ? `DAY ${run.dayNumber}` : `ENDLESS · ${run.category.toUpperCase()}`) : today ? `DAY ${today.dayNumber}` : "…"}</small>
        </button>
        <div className="box center"><small>ALTITUDE</small><b>{fmtKm(alt)}</b><small className="zone">{zoneFor(alt).toUpperCase()}</small></div>
        <div className="box right"><small>SCORE</small><b key={screen === "menu" ? 0 : score} className="bump">{screen === "menu" ? 0 : score}</b>
          <button className="mute" onClick={() => { setSound(!sound); ls.set("lo:sound", !sound); }} aria-pressed={!sound}>{sound ? "SOUND ON" : "MUTED"}</button>
        </div>
      </header>

      {replay !== null && screen === "end" && (
        <div className="replay-bar" role="status"><span className="dot" /> Replaying your flight · {fmtKm(altFor(replay))}<button className="link" onClick={stopReplay}>skip</button></div>
      )}
      <section className={`panel${replay !== null && screen === "end" ? " away" : ""}`} aria-live="polite">
        {error && <p className="err">{error}</p>}
        {busy && <p className="busy"><span className="dot" />{busy}</p>}

        {screen === "menu" && (
          <div className="menu">
            <h1>Name the thing <span className="hl">nobody else</span> will.</h1>
            <p className="lede">Seven prompts. Obvious answers barely leave the pad; rare ones reach the Moon.</p>
            <PlayerCard prof={prof} onClaim={claimBonus} bonus={bonus} onOpen={() => setScreen("stats")} />

            <div className="daily">
              <div className="daily-main">
                <div className="daily-top"><span className="pill-tag">DAILY LAUNCH</span><small>DAY {today?.dayNumber ?? "…"} · resets in {countdown}</small></div>
                {dailyDone ? (
                  <div className="daily-done">
                    <b>{dailyMine!.results.reduce((a, x) => a + x.score, 0)} pts</b>
                    <TierRow tiers={dailyMine!.results.map((r) => r.tier)} small />
                    {preview?.me && <small>#{preview.me.rank} of {preview.players} today</small>}
                  </div>
                ) : <p>Same 7 prompts for everyone today. One shot at the leaderboard.</p>}
                <button className="cta" disabled={!today || !!busy} onClick={startDaily}>
                  {dailyDone ? "VIEW MY FLIGHT LOG" : dailyInProgress ? `RESUME · ${dailyMine!.results.length}/${dailyMine!.prompts.length} ▲` : "LAUNCH ▲"}
                </button>
              </div>
              <div className="daily-board">
                <div className="daily-top"><small>TODAY&apos;S TOP PILOTS</small><small>{preview ? `${preview.players} played` : ""}</small></div>
                {!preview ? <p className="muted small">Loading…</p> : preview.rows.length === 0 ? <p className="muted small">Nobody has launched yet today. Be the first name on the board!</p> : (
                  <ol className="mini">{preview.rows.slice(0, 3).map((r, i) => (
                    <li key={i} className={r.you ? "you" : ""}><span className={`rk-chip r${r.rank}`}>{r.rank}</span><span className="nm">{r.name}</span><b>{r.score}</b></li>
                  ))}</ol>
                )}
                <button className="link more" onClick={openBoard}>Full leaderboard <Icon name="arrow" size={14} /></button>
              </div>
            </div>

            <div className="endless">
              <div className="daily-top"><span className="pill-tag cyan">ENDLESS</span><small>fresh prompts every run · earns XP &amp; overall points</small></div>
              <div className="chips">{CATS.map((c) => <button key={c} className={c === category ? "chip on" : "chip"} onClick={() => setCategory(c)}>{c}</button>)}</div>
              <button className="cta2" disabled={!!busy} onClick={() => start("endless", category)}>PRACTICE · {category.toUpperCase()} ▲</button>
            </div>

            <a className="party-cta" href="/party"><span className="party-ico"><Icon name="users" size={20} /></span><span><b>PLAY WITH FRIENDS</b><small>Make a room, share the code, race your crew live.</small></span><span className="arrow"><Icon name="arrow" size={18} /></span></a>
            <nav className="menu-nav">
              <button className="ghost" onClick={openBoard}><Icon name="trophy" /> Leaderboard</button>
              <button className="ghost" onClick={() => setScreen("stats")}><Icon name="chart" /> Stats</button>
              <button className="ghost" onClick={() => setScreen("how")}><Icon name="help" /> How to play</button>
            </nav>
            {today?.mock && <p className="muted small">Test mode: using the built-in prompt pool (no AI key set).</p>}
          </div>
        )}

        {screen === "play" && run && (
          <div>
            {fred && <div key={fred.k} className="fred"><span className="fred-av" aria-hidden="true">FD</span><p>{fred.text}</p></div>}
            {!showingResult && current && (
              <>
                <div className="rnd"><span>PROMPT {round + 1} OF {run.prompts.length} · {current.category.toUpperCase()}{hot >= 2 && <b key={hot} className="hot"><Icon name="sparkle" size={12} /> {hot} in a row</b>}</span>{triesLeft !== null && <span>{triesLeft} {triesLeft === 1 ? "TRY" : "TRIES"} LEFT</span>}</div>
                <h2 key={current.id} className="prompt">{current.text}</h2>
                {hint && <p className={`hint${boosted ? " boosted" : ""}`}>Navigator: {hint} <em>{boosted ? "(boost used: full points!)" : "(this round scores half)"}</em></p>}
                <form className="row" onSubmit={(e) => { e.preventDefault(); void submit(); }}>
                  <input ref={inputRef} value={draft} onChange={(e) => setDraft(e.target.value)} maxLength={60} placeholder="the rarer, the higher…" aria-label="Your answer" autoComplete="off" spellCheck={false} disabled={!!busy} />
                  <button type="submit" disabled={!!busy || !draft.trim()}>LAUNCH ▲</button>
                </form>
                {crash && <CrashCard text={crash.text} kind={crash.kind} seed={crash.seed} />}
                {msg && msg !== "__result__" && <p className="err">{msg}</p>}
                <div className="row small-actions">
                  {!hint && (prof?.profile.boosts ?? 0) > 0 && <button className="link boost" onClick={() => getHint(true)} disabled={!!busy}><Icon name="sparkle" size={13} /> use a boost ({prof!.profile.boosts} left): free hint, full points</button>}
                  <button className="link" onClick={() => getHint(false)} disabled={!!hint || !!busy}>{hint ? "hint used" : "need a hint? (half points)"}</button>
                  <button className="link" onClick={() => submit(true)} disabled={!!busy}>skip prompt</button>
                </div>
              </>
            )}

            {showingResult && last && (
              <div key={round} className={`result ${last.tier ?? "miss"}`} style={{ ["--tc" as string]: last.tier ? `var(--${last.tier})` : "var(--miss)" }}>
                <div className="rnd"><span>PROMPT {round} OF {run.prompts.length}</span></div>
                <p className="ptext">{run.prompts[round - 1].text}</p>
                <Stamp tier={last.tier} seed={round} />
                {last.score > 0 && <span key={`fly${round}`} className="flypts" aria-hidden="true">+{last.score}</span>}
                {!last.tier && !last.skipped && <div className="stamp fuel">Out of fuel</div>}
                <div className="tname">{last.tier ? `${TIER_NAMES[last.tier]} · +${last.score} PTS` : last.skipped ? "PASSED · +0" : "NOTHING LAUNCHED · +0"}</div>
                <div className="tans">{last.answer ? `“${last.answer}”` : "—"}</div>
                <p className="tsub">{last.quip}{last.share !== undefined && last.tier ? ` About ${last.share < 1 ? last.share.toFixed(2) : Math.round(last.share)}% of people would say this.` : ""}{last.hint ? " Hint used: half points." : ""}</p>
                {last.tier && <CurioCard curio={curio} answer={last.answer} share={last.share} />}
                {reveal ? (
                  <ul className="reveal">
                    <li className="muted">{reveal.total} player{reveal.total === 1 ? "" : "s"} on Liftoffle answered so far</li>
                    {reveal.answers.map((a) => <li key={a.answer}><span>{a.answer}</span><span className="bar"><i style={{ width: `${Math.min(100, a.pct)}%` }} /></span><span>{a.pct}%</span></li>)}
                  </ul>
                ) : <button className="link" onClick={showReveal}>what did everyone else say?</button>}
                <div className="row"><button onClick={next} autoFocus>{round >= run.prompts.length ? "SEE FLIGHT LOG ▲" : "NEXT ▲"}</button></div>
              </div>
            )}
            <Dots run={run} />
          </div>
        )}

        {screen === "end" && run && (
          <div className="end">
            <div className="scorecard" style={{ ["--tc" as string]: `var(--${zoneTier(score)})` }}>
              <small>{run.mode === "daily" ? `DAY ${run.dayNumber} · FLIGHT LOG` : `ENDLESS · ${run.category.toUpperCase()}`}</small>
              <div className="big">{score}<span>pts</span></div>
              <p className="muted">{fmtKm(altFor(score))} · you reached {zoneFor(altFor(score))}</p>
              <TierRow tiers={run.results.map((r) => r.tier)} />
              {run.mode === "daily" && (finish?.pending ? <p className="muted small">Checking the leaderboard…</p> : finish?.rank ? (
                <div className="ranks">
                  <div><b>#{finish.rank}</b><small>of {finish.players} today</small></div>
                  <div><b>{finish.beat}%</b><small>beaten</small></div>
                  <div><b>{finish.streak}</b><small>day streak</small></div>
                </div>
              ) : finish?.error ? <p className="err">{finish.error}</p> : null)}
              {finish?.counted !== undefined && finish.counted !== score && <p className="muted small">The board counts your first daily run ({finish.counted}).</p>}
            </div>
            {finish?.reward && <RewardCard r={finish.reward} />}
            {finish && !finish.pending && !finish.error && (
              analysis ? <div className="mind"><small>YOUR PILOT PROFILE</small><b>{analysis.title}</b><p>{analysis.text}</p><em>Just for fun, not a real assessment.</em></div>
                : <p className="mind loading muted small"><span className="dot" />The flight psychologist is reading your answers…</p>
            )}
            {run.mode === "daily" && finish?.rank && <NameEditor nick={nick} prompt onSaved={onNameSaved} />}
            <ul className="log">{run.results.map((r, i) => <li key={i}><i className={`lg-e ${r.tier ?? "miss"}`} /><span className="lg-q">{run.prompts[i].text} → <b>{r.answer ?? "—"}</b></span><span>+{r.score}</span></li>)}</ul>
            <div className="end-actions">
              <button onClick={shareImage} disabled={sharing}>{sharing ? "DRAWING…" : "SHARE MY FLIGHT"}</button>
              <button className="ghost" onClick={copyResult}>{copied ? "COPIED ✓" : "COPY TEXT"}</button>
              <button className="ghost" onClick={() => startReplay(score)} disabled={replay !== null}><Icon name="arrow" size={14} /> REPLAY FLIGHT</button>
              <button className="ghost" onClick={openBoard}><Icon name="trophy" /> Leaderboard</button>
              <button className="ghost" onClick={() => start("endless", run.mode === "endless" ? run.category : category)}>ENDLESS ▲</button>
            </div>
            {run.mode === "daily" && <p className="muted small">Next daily launch in {countdown}.</p>}
          </div>
        )}

        {screen === "board" && (
          <div className="boardv">
            <div className="board-head">
              <h2>Leaderboard</h2>
              <div className="tabs" role="tablist">
                {(["today", "yesterday", "week", "all"] as const).map((d) => <button key={d} role="tab" aria-selected={boardDay === d} className={boardDay === d ? "tab on" : "tab"} onClick={() => loadBoard(d)}>{BOARD_TABS[d]}</button>)}
              </div>
            </div>
            <NameEditor nick={nick} onSaved={onNameSaved} />
            {(boardDay === "week" || boardDay === "all") && <p className="muted small board-note">{boardDay === "week" ? "Every point from daily and endless runs since Monday 00:00 UTC." : "Every point you've ever earned: daily runs (first try each day) and endless runs."}</p>}
            {!board ? <p className="muted">Loading…</p> : board.rows.length === 0 ? <p className="muted empty">{boardDay === "today" ? "Nobody has launched today yet. Play the daily and take #1!" : boardDay === "yesterday" ? "Nobody played yesterday." : "No points on this board yet. Finish a run to be first!"}</p> : (
              <>
                <p className="muted small">{board.players} pilot{board.players === 1 ? "" : "s"} · {boardDay === "all" ? "All time" : boardDay === "week" ? `Week of ${board.date}` : `Day ${board.date}`}</p>
                <div className="podium">{[1, 0, 2].map((i) => { const r = board.rows[i]; return r ? (
                  <div key={i} className={`pod s${i}${r.you ? " you" : ""}`}><span className={`rk-chip big r${r.rank}`}>{r.rank}</span><b className="nm">{r.name}{r.you ? " (you)" : ""}</b><span className="sc">{r.score.toLocaleString()}</span>{r.level ? <LvlChip level={r.level} /> : null}<div className="blk" /></div>
                ) : <div key={i} className={`pod s${i} empty`} />; })}</div>
                <ol className="board">{board.rows.slice(3).map((r, i) => (
                  <li key={i} className={r.you ? "you" : ""}><span className="rk">#{r.rank}</span><span className="nm">{r.name}{r.you ? " (you)" : ""}</span>{r.level ? <LvlChip level={r.level} /> : <TierRow tiers={fromGrid(r.grid)} small />}<b>{r.score.toLocaleString()}</b></li>
                ))}</ol>
                {board.me && !board.me.inTop && (
                  <ol className="board mine"><li className="you"><span className="rk">#{board.me.rank}</span><span className="nm">{board.me.name} (you)</span>{board.me.level ? <LvlChip level={board.me.level} /> : <TierRow tiers={fromGrid(board.me.grid)} small />}<b>{board.me.score.toLocaleString()}</b></li></ol>
                )}
                {!board.me && boardDay === "today" && <p className="muted small">You&apos;re not on today&apos;s board yet. Finish the daily launch to get ranked.</p>}
              </>
            )}
            <button className="ghost" onClick={() => setScreen("menu")}>BACK</button>
          </div>
        )}

        {screen === "stats" && (() => {
          // the server profile is the source of truth; stats from before it existed are folded in
          const sp = prof?.profile, lg = sp?.legacy;
          const played = sp ? sp.played + (lg?.played ?? 0) : stats.played;
          const best = sp ? Math.max(sp.best, lg?.best ?? 0) : stats.best;
          const total = sp ? sp.total + (lg?.total ?? 0) : stats.total;
          const tiers: Record<string, number> = sp ? { ...(lg?.tiers ?? {}) } : stats.tiers;
          if (sp) for (const [k, n] of Object.entries(sp.tiers)) tiers[k] = (tiers[k] ?? 0) + n;
          const fav = sp ? Object.entries(sp.categories).sort((a, b) => b[1] - a[1])[0] : undefined;
          return (
          <div>
            <h2>My stats</h2>
            {prof && <PlayerCard prof={prof} onClaim={claimBonus} bonus={bonus} compact />}
            <div className="statgrid">
              <div><b>{played}</b><small>flights</small></div>
              <div><b>{best}</b><small>best score</small></div>
              <div><b>{played ? Math.round(total / played) : 0}</b><small>average</small></div>
              <div><b>{finish?.streak ?? "–"}</b><small>daily streak</small></div>
            </div>
            {sp && (
              <div className="statgrid">
                <div><b>{sp.accepted}</b><small>answers landed</small></div>
                <div><b>{sp.rejected}</b><small>crashes</small></div>
                <div><b>{sp.attempts ? Math.round((sp.accepted / sp.attempts) * 100) : 0}%</b><small>accuracy</small></div>
                <div><b>{fav ? fav[0] : "–"}</b><small>favourite topic</small></div>
              </div>
            )}
            {sp?.rarest && <p className="curio-best">Your rarest answer ever: <b>{sp.rarest.answer}</b> for “{sp.rarest.prompt}”, said by about {sp.rarest.share < 1 ? sp.rarest.share.toFixed(2) : Math.round(sp.rarest.share)}% of people.</p>}
            <ul className="tiers">{["t5", "t4", "t3", "t2", "t1", "miss"].map((t) => {
              const n = tiers[t] ?? 0, max = Math.max(1, ...Object.values(tiers));
              return <li key={t}><span>{t === "miss" ? "MISSED" : TIER_NAMES[t]}</span><span className="bar"><i style={{ width: `${(n / max) * 100}%`, background: t === "miss" ? "var(--miss)" : `var(--${t})` }} /></span><span>{n}</span></li>;
            })}</ul>
            {prof && prof.runs.length > 0 && (
              <>
                <h3>Recent flights</h3>
                <ul className="log">{prof.runs.slice(0, 10).map((r, i) => <li key={i}><TierRow tiers={r.tiers} small /><span className="lg-q">{r.mode === "daily" ? `Daily · ${r.date}` : `Endless · ${r.category}`}</span><span>{r.score}</span></li>)}</ul>
              </>
            )}
            {prof && prof.answers.length > 0 && (
              <>
                <h3>Your latest answers <small className="muted">({prof.answerTotal} saved)</small></h3>
                <ul className="log">{prof.answers.slice(0, 12).map((a, i) => <li key={i}><i className={`lg-e ${a.tier ?? "miss"}`} /><span className="lg-q">{a.prompt} → <b>{a.skipped ? "skipped" : a.valid ? a.answer : `${a.typed} ✗`}</b></span><span className="muted small">{a.mode}</span></li>)}</ul>
              </>
            )}
            <SkyLog sights={sights} />
            <BadgeGrid server={sp?.badges} />
            <p className="muted small">{prof ? "Your stats, answers and achievements are saved to your player profile on the server (no email or IP needed)." : "Loading your saved profile…"}</p>
            <button className="ghost" onClick={() => setScreen("menu")}>BACK</button>
          </div>
          );
        })()}

        {screen === "how" && (
          <div className="how">
            <h2>How to play</h2>
            <p>Each prompt asks you to name one thing. An AI judge checks your answer is real and fits, so typos are forgiven but made-up things aren&apos;t. You get 3 tries per prompt.</p>
            <p>The fewer launchers who gave the same answer, the more points: <b style={{ color: "var(--t1)" }}>Ground crew 10</b> · <b style={{ color: "var(--t2)" }}>Pilot 25</b> · <b style={{ color: "var(--t3)" }}>Astronaut 50</b> · <b style={{ color: "var(--t4)" }}>Voyager 75</b> · <b style={{ color: "var(--t5)" }}>Light-year 100</b>.</p>
            <p>Rarity is based on how people <b>in general</b> answer: for every prompt the AI builds a survey of what 1,000 typical people would say, like Family Feud. Common answers score low; answers that aren&apos;t on the survey at all score highest. A hint halves that round&apos;s points.</p>
            <p>Daily Launch is the same for everyone and resets at 00:00 UTC. Endless writes brand-new prompts every run.</p>
            <p><b>Levels &amp; boards:</b> every point you score is XP. Level up to climb the ranks from Cadet to Star Legend, and compete on the <b>This week</b> and <b>All-time</b> boards. Only your first daily run each day counts there.</p>
            <p><b>Boosts:</b> a boost is a free hint that keeps full points. Claim the <b>daily bonus</b> once a day for more: day 3 gives double, day 7 is the jackpot. Levelling up gives one too (max {MAX_BOOSTS}).</p>
            <button className="ghost" onClick={() => setScreen("menu")}>BACK</button>
          </div>
        )}
      </section>
    </main>
  );
}

const BOARD_TABS: Record<BoardDay, string> = { today: "TODAY", yesterday: "YESTERDAY", week: "THIS WEEK", all: "ALL-TIME" };

const LvlChip = ({ level }: { level: number }) => <span className="lvl-chip" title={`Level ${level}`}>LV {level}</span>;

/** Level, XP to the next level, boosts and the daily bonus: the reasons to come back tomorrow. */
function PlayerCard({ prof, onClaim, bonus, onOpen, compact = false }: { prof: ServerProfile | null; onClaim: () => void; bonus: { gained: number; streak: number; label: string } | null; onOpen?: () => void; compact?: boolean }) {
  if (!prof) return <div className="pcard skeleton" aria-hidden="true" />;
  const { level: lv, profile: p, bonusReady, allTimeRank } = prof;
  // the streak continues only if the last claim was yesterday (UTC)
  const yesterday = new Date(Date.now() - 864e5).toISOString().slice(0, 10);
  const next = dailyReward((p.checkin.last === yesterday ? p.checkin.n : 0) + 1);
  return (
    <div className={`pcard${compact ? " compact" : ""}`}>
      <button className="pcard-main" onClick={onOpen} disabled={!onOpen} aria-label="Open my stats">
        <span className="lvl-ring" style={{ ["--p" as string]: `${lv.pct}%` }}><b>{lv.level}</b></span>
        <span className="pcard-info">
          <span className="pcard-title">{lv.title}{allTimeRank ? <small> · #{allTimeRank} all-time</small> : null}</span>
          <span className="xpbar" aria-label={`${lv.into} of ${lv.need} XP to level ${lv.level + 1}`}><i style={{ width: `${lv.pct}%` }} /></span>
          <small className="muted">{lv.into.toLocaleString()} / {lv.need.toLocaleString()} XP to level {lv.level + 1}</small>
        </span>
      </button>
      <div className="pcard-side">
        <span className="pstat" title="Boosts: a free hint that keeps full points"><Icon name="sparkle" size={13} /> <b>{p.boosts}</b><small>/{MAX_BOOSTS} boosts</small></span>
        <span className="pstat" title="Daily bonus streak">🔥 <b>{p.checkin.n}</b><small> day{p.checkin.n === 1 ? "" : "s"}</small></span>
      </div>
      {bonus ? (
        <div className="bonus-done" role="status">+{bonus.gained} boost{bonus.gained === 1 ? "" : "s"} · {bonus.label} · day {bonus.streak} 🔥{bonus.gained === 0 ? " (boosts full)" : ""}</div>
      ) : bonusReady ? (
        <button className="bonus-btn" onClick={onClaim}><span className="gift" aria-hidden="true">🎁</span> CLAIM DAILY BONUS <small>+{next.boosts} boost{next.boosts === 1 ? "" : "s"}{next.boosts > 1 ? ` · ${next.label}` : ""}</small></button>
      ) : !compact ? <p className="muted small bonus-wait">Bonus claimed today. Come back tomorrow to keep your streak{p.checkin.n % 7 === 6 ? " and hit the 7-day jackpot (+3)" : ""}.</p> : null}
    </div>
  );
}

/** XP earned by the run, the level bar filling up, and any level up. */
function RewardCard({ r }: { r: Reward }) {
  const before = levelFor(r.xp - r.xpGained), after = levelFor(r.xp);
  const [fill, setFill] = useState(r.levelAfter > r.levelBefore ? 0 : before.pct);
  useEffect(() => { const t = setTimeout(() => setFill(after.pct), 250); return () => clearTimeout(t); }, [after.pct]);
  const up = r.levelAfter > r.levelBefore;
  return (
    <div className={`reward${up ? " up" : ""}`}>
      {up && <div className="levelup"><small>LEVEL UP</small><b>Level {after.level} · {after.title}</b>{r.boostsEarned > 0 && <em>+{r.boostsEarned} boost{r.boostsEarned === 1 ? "" : "s"}</em>}</div>}
      <div className="reward-row">
        <span className="xp-gain">{r.counted ? `+${r.xpGained} XP` : "Practice replay · no XP"}</span>
        <span className="muted small">LV {after.level} · {after.into}/{after.need}</span>
      </div>
      <span className="xpbar big"><i style={{ width: `${fill}%` }} /></span>
      {!r.counted && <p className="muted small">Only your first daily run of the day counts toward XP and the overall boards.</p>}
    </div>
  );
}

/** Pops up at the top when the rocket passes something. */
function SpotToast({ id, fresh, count }: { id: string; fresh: boolean; count: number }) {
  const s = SIGHTS.find((x) => x.id === id); if (!s) return null;
  return (
    <div className={`spot${fresh ? " fresh" : ""}`} role="status">
      <small>{fresh ? `NEW SIGHTING · ${count}/${SIGHTS.length} IN YOUR SKY LOG` : "SPOTTED"}</small>
      <b>{s.name}</b><em>{fmtKm(s.km)} up</em>
    </div>
  );
}

/** Everything you can see on the way up; the ones you haven't reached stay hidden. */
function SkyLog({ sights }: { sights: Record<string, number> }) {
  const n = SIGHTS.filter((s) => sights[s.id]).length;
  return (
    <div className="skylog">
      <h3>Sky Log <small>{n}/{SIGHTS.length} spotted</small></h3>
      <ol>{SIGHTS.map((s, i) => (
        <li key={s.id} className={sights[s.id] ? "on" : ""} style={{ animationDelay: `${i * 0.025}s` }}>
          <span className="alt">{fmtKm(s.km)}</span><b>{sights[s.id] ? s.name : "???"}</b>
        </li>
      ))}</ol>
      <p className="muted small">Score higher to fly further: rarer answers take you past the Moon and out to Jupiter.</p>
    </div>
  );
}

/** "Did you know?" for the answer just given, plus how the crowd answered and where yours landed. */
function CurioCard({ curio, answer, share }: { curio: Curio | null; answer: string | null; share?: number }) {
  if (!curio) return <p className="curio muted small"><span className="dot" />Asking the crowd…</p>;
  const pct = (n: number) => (n < 1 ? n.toFixed(1) : String(Math.round(n)));
  const same = (x?: string | null) => (x ?? "").toLowerCase() === (answer ?? "").toLowerCase();
  const crowd = curio.crowd ?? [];
  const mineIdx = curio.place ? curio.place - 1 : -1;
  const mine = share ?? (mineIdx >= 0 ? crowd[mineIdx]?.pct : undefined);
  // share of people who'd give a more common answer than yours
  const beat = mine !== undefined ? Math.min(99, Math.round(crowd.filter((e, i) => i !== mineIdx && e.pct > mine).reduce((a, e) => a + e.pct, 0))) : null;
  const rows = crowd.slice(0, 5).map((e, i) => ({ ...e, you: i === mineIdx }));
  if (answer && mineIdx < 0 || mineIdx >= 5) rows.push({ name: answer ?? "", pct: mine ?? 0, you: true });
  const max = Math.max(1, ...rows.map((r) => r.pct));
  return (
    <div className="curio">
      {crowd.length > 0 && (
        <>
          <div className="crowd-head"><b>HOW THE CROWD ANSWERED</b>{beat !== null && beat > 0 && <span className="beat">rarer than {beat}% of answers</span>}</div>
          <ul className="crowd">{rows.map((r, i) => (
            <li key={i} className={r.you ? "you" : ""} style={{ animationDelay: `${i * 0.06}s` }}>
              <span className="nm">{r.you && i >= 5 ? "…" : ""}{r.name}{r.you ? " (you)" : ""}</span>
              <span className="bar"><i style={{ width: `${Math.max(2, (r.pct / max) * 100)}%`, animationDelay: `${0.1 + i * 0.06}s` }} /></span>
              <span className="pc">{r.you && mineIdx < 0 ? `~${pct(r.pct)}%` : `${pct(r.pct)}%`}</span>
            </li>
          ))}</ul>
          {curio.deep && !same(curio.deep.name) && <p className="muted small">Deepest cut on the survey: {curio.deep.name} ({pct(curio.deep.pct)}%).</p>}
        </>
      )}
      {curio.fact && <p className="fact"><b>DID YOU KNOW?</b> {curio.fact}</p>}
      {crowd.length > 0 && <p className="est">Estimated: the AI surveys how 1,000 typical people would answer{mineIdx < 0 ? "; answers it didn't list get its best guess" : ""}.</p>}
    </div>
  );
}

/** Draws the shareable flight card (1080×1350 PNG) on a canvas. */
async function drawShareCard(d: { head: string; score: number; km: number; zone: string; tiers: (string | null)[]; rank: { n: number; of: number } | null; rare: number; title: string | null; url: string }): Promise<Blob> {
  const W = 1080, H = 1350, c = document.createElement("canvas"); c.width = W; c.height = H;
  const x = c.getContext("2d")!;
  await document.fonts?.ready;
  const font = getComputedStyle(document.body).fontFamily, mono = getComputedStyle(document.documentElement).getPropertyValue("--font-mono").trim() || "monospace";
  // night sky
  const bg = x.createLinearGradient(0, 0, 0, H); bg.addColorStop(0, "#070814"); bg.addColorStop(0.55, "#16153a"); bg.addColorStop(1, "#4a3b78");
  x.fillStyle = bg; x.fillRect(0, 0, W, H);
  let seed = Math.round(d.score * 7 + 3); const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  for (let i = 0; i < 160; i++) { x.globalAlpha = 0.25 + rnd() * 0.75; x.fillStyle = "#fff"; x.beginPath(); x.arc(rnd() * W, rnd() * H * 0.8, rnd() * 2.2 + 0.4, 0, 7); x.fill(); }
  x.globalAlpha = 1;
  // horizon glow + skyline
  const hg = x.createLinearGradient(0, H - 260, 0, H); hg.addColorStop(0, "rgba(244,124,150,0)"); hg.addColorStop(1, "rgba(255,170,120,.45)"); x.fillStyle = hg; x.fillRect(0, H - 260, W, 260);
  x.fillStyle = "#0b0a1c"; for (let bx = 0; bx < W; ) { const w = 30 + rnd() * 60, h = 40 + rnd() * 110; x.fillRect(bx, H - h, w, h); bx += w + 2; }
  // dashed flight path + rocket
  x.strokeStyle = "rgba(255,255,255,.35)"; x.setLineDash([6, 14]); x.lineWidth = 3; x.beginPath(); x.moveTo(W - 170, H - 120); x.lineTo(W - 170, 300); x.stroke(); x.setLineDash([]);
  x.save(); x.translate(W - 170, 250); x.scale(3, 3);
  x.fillStyle = "rgba(255,170,70,.85)"; x.beginPath(); x.moveTo(-6, 18); x.quadraticCurveTo(0, 48, 6, 18); x.fill();
  x.fillStyle = "#ff5f6d"; x.beginPath(); x.moveTo(-9, 2); x.quadraticCurveTo(-19, 10, -18, 24); x.lineTo(-9, 17); x.fill(); x.beginPath(); x.moveTo(9, 2); x.quadraticCurveTo(19, 10, 18, 24); x.lineTo(9, 17); x.fill();
  x.fillStyle = "#eef0fb"; x.beginPath(); x.moveTo(0, -32); x.bezierCurveTo(13, -20, 11, 4, 9, 18); x.lineTo(-9, 18); x.bezierCurveTo(-11, 4, -13, -20, 0, -32); x.fill();
  x.fillStyle = "#5fd3ff"; x.beginPath(); x.arc(0, -8, 4.5, 0, 7); x.fill(); x.restore();
  // text
  const L = 90;
  x.fillStyle = "#eef0fb"; x.font = `700 44px ${font}`; x.fillText("LIFTOFF", L, 150); const lw = x.measureText("LIFTOFF").width; x.fillStyle = "#f472d0"; x.fillText("LE", L + lw, 150);
  x.fillStyle = "#949bb9"; x.font = `600 30px ${font}`; x.fillText(d.head, L, 205);
  x.fillStyle = "#ffffff"; x.font = `700 150px ${mono}`; x.fillText(fmtKm(d.km), L, 420);
  x.fillStyle = "#f9a8e0"; x.font = `600 34px ${font}`; x.fillText(`reached ${d.zone}`.toUpperCase().slice(0, 40), L, 480);
  // tier tiles
  const COL: Record<string, string> = { t1: "#a3acc9", t2: "#67c7f5", t3: "#6ee7a8", t4: "#fcd34d", t5: "#f472d0" };
  d.tiers.forEach((t, i) => { x.fillStyle = t ? COL[t] : "rgba(248,113,113,.55)"; x.beginPath(); x.roundRect(L + i * 92, 560, 76, 76, 16); x.fill(); });
  // stats row
  const stats: [string, string][] = [[`${d.score}`, "points"], d.rank ? [`#${d.rank.n}`, `of ${d.rank.of} today`] : [`${d.tiers.filter(Boolean).length}/${d.tiers.length}`, "landed"], [`${d.rare}`, "rare answers"]];
  stats.forEach(([v, l], i) => { const sx = L + i * 300; x.fillStyle = "#ffffff"; x.font = `700 64px ${mono}`; x.fillText(v, sx, 780); x.fillStyle = "#949bb9"; x.font = `600 28px ${font}`; x.fillText(l.toUpperCase(), sx, 825); });
  if (d.title) { x.fillStyle = "#fcd34d"; x.font = `600 30px ${font}`; x.fillText("PILOT PROFILE", L, 920); x.fillStyle = "#ffffff"; x.font = `700 52px ${font}`; x.fillText(d.title.slice(0, 28), L, 980); }
  x.fillStyle = "#eef0fb"; x.font = `600 40px ${font}`; x.fillText("Can you fly higher?", L, 1100);
  x.fillStyle = "#7dd3fc"; x.font = `600 34px ${mono}`; x.fillText(d.url, L, 1155);
  return new Promise((res, rej) => c.toBlob((b) => (b ? res(b) : rej(new Error("toBlob failed"))), "image/png"));
}

const zoneTier = (score: number) => (score >= 500 ? "t5" : score >= 350 ? "t4" : score >= 220 ? "t3" : score >= 120 ? "t2" : "t1");

/** Set or change your public board name. Saves to the server, so it shows on today's board straight away. */
function NameEditor({ nick, prompt = false, onSaved }: { nick: string; prompt?: boolean; onSaved: (n: string) => void }) {
  const [draft, setDraft] = useState(nick);
  const [state, setState] = useState<{ busy?: boolean; ok?: boolean; err?: string }>({});
  useEffect(() => { setDraft(nick); }, [nick]);
  const dirty = draft.trim() !== nick.trim();
  async function save() {
    if (!dirty || state.busy) return;
    setState({ busy: true });
    try { const r = await api<{ name: string }>("/api/nickname", { nickname: draft }); setState({ ok: true }); onSaved(r.name); setDraft(r.name); setTimeout(() => setState({}), 2200); }
    catch (e) { setState({ err: (e as Error).message }); }
  }
  if (prompt && nick && !dirty && !state.ok) return null; // already named: don't nag on the end screen
  return (
    <form className={`name-ed${prompt ? " nudge" : ""}`} onSubmit={(e) => { e.preventDefault(); void save(); }}>
      <label htmlFor="nm">{prompt ? "Put your name on the board" : "Your name on the board"}</label>
      <div className="row">
        <input id="nm" value={draft} maxLength={16} placeholder="e.g. Nova" autoComplete="nickname" spellCheck={false}
          onChange={(e) => { setDraft(e.target.value.replace(/[^\p{L}\p{M}\p{N} _.-]/gu, "")); setState({}); }} />
        <button type="submit" disabled={!dirty || draft.trim().length < 2 || state.busy}>{state.busy ? "…" : state.ok ? "SAVED ✓" : "SAVE"}</button>
      </div>
      {state.err && <p className="err">{state.err}</p>}
      {!state.err && <small className="muted">{state.ok ? "Updated on the leaderboard." : "2–16 letters or numbers. You can change it any time."}</small>}
    </form>
  );
}

const GRID_TIER: Record<string, string | null> = { "⬜": "t1", "🟦": "t2", "🟩": "t3", "🟨": "t4", "🟪": "t5", "⬛": null };
const fromGrid = (g: string) => [...(g || "")].filter((c) => c in GRID_TIER).map((c) => GRID_TIER[c]);
/** A row of small tier-coloured tiles (the share text still uses emoji squares). */
function TierRow({ tiers, small = false }: { tiers: (string | null)[]; small?: boolean }) {
  if (!tiers.length) return null;
  return <span className={`tiles${small ? " sm" : ""}`} aria-label="result grid">{tiers.map((t, i) => <i key={i} className={t ?? "miss"} style={{ animationDelay: `${i * 0.05}s` }} />)}</span>;
}

function Dots({ run }: { run: Run }) {
  return (
    <div className="dots" aria-hidden="true">
      {run.prompts.map((_, i) => {
        const r = run.results[i];
        return <i key={i} style={{ background: r ? (r.tier ? `var(--${r.tier})` : "var(--miss)") : i === run.results.length ? "rgba(255,255,255,.35)" : undefined }} />;
      })}
    </div>
  );
}
