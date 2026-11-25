"use client";
// Unlockable badges (kept in this browser) and Flight Director Fred, the commentator.
import { useEffect, useState } from "react";
import { beep } from "./client";

export type Badge = { id: string; e: string; name: string; how: string };
export const BADGES: Badge[] = [
  { id: "first_flight", e: "🚀", name: "First Flight", how: "Finish your first run" },
  { id: "galaxy_brain", e: "🤯", name: "Galaxy Brain", how: "Land a Light-Year answer" },
  { id: "hot_streak", e: "🔥", name: "Hot Streak", how: "3 Astronaut-or-better answers in a row" },
  { id: "flawless", e: "💎", name: "Flawless Launch", how: "Finish a run with zero misses" },
  { id: "moonwalker", e: "🌕", name: "Moonwalker", how: "Score 400+ in one run" },
  { id: "comeback", e: "🔁", name: "Third Time's the Charm", how: "Get it right on your last try" },
  { id: "three_peat", e: "📅", name: "Three-peat", how: "Play the daily 3 days in a row" },
  { id: "night_owl", e: "🦉", name: "Night Owl", how: "Play between midnight and 5am" },
  { id: "party_champ", e: "🏆", name: "Party Champion", how: "Win a party game" },
  // milestones: checked on the server from your saved profile
  { id: "ten_flights", e: "🛫", name: "Frequent Flyer", how: "Finish 10 runs" },
  { id: "fifty_flights", e: "🛰️", name: "Orbital Regular", how: "Finish 50 runs" },
  { id: "hundred_flights", e: "🌌", name: "Centurion", how: "Finish 100 runs" },
  { id: "k_points", e: "⭐", name: "Four Digits", how: "Earn 1,000 lifetime points" },
  { id: "ten_k_points", e: "🌠", name: "Star Hoarder", how: "Earn 10,000 lifetime points" },
  { id: "century", e: "💯", name: "Hundred Answers", how: "Land 100 accepted answers" },
  { id: "explorer", e: "🧭", name: "Explorer", how: "Land answers in 6 different topics" },
  { id: "loyal", e: "🔥", name: "Loyal Crew", how: "Claim the daily bonus 7 days in a row" },
  { id: "level_five", e: "🎖️", name: "Rising Star", how: "Reach level 5" },
  { id: "level_ten", e: "👑", name: "Double Digits", how: "Reach level 10" },
  { id: "sky_spotter", e: "🔭", name: "Sky Spotter", how: "Spot 12 things in your Sky Log" },
  { id: "jupiter", e: "🪐", name: "Jupiter Bound", how: "Fly all the way to Jupiter" },
  { id: "sudden_death", e: "⚔️", name: "Ice in the Veins", how: "Win a Sudden Death final" },
  // the hall of shame
  { id: "crash_dummy", e: "💥", name: "Crash Test Dummy", how: "Get rejected 3 times on one prompt" },
  { id: "cat_keyboard", e: "🐈", name: "Cat on the Keyboard", how: "Submit a keyboard smash" },
  { id: "broken_record", e: "📢", name: "Broken Record", how: "Try the same wrong answer twice" },
  { id: "chicken", e: "🐔", name: "Professional Chicken", how: "Pass 3 prompts in one run" },
  { id: "captain_obvious", e: "🥱", name: "Captain Obvious", how: "3 Ground Crew answers in one run" },
  { id: "class_clown", e: "🤡", name: "Class Clown", how: "Win Blooper of the Game in a party" },
];

const KEY = "lo:badges";
export function unlocked(): Record<string, number> {
  try { return JSON.parse(localStorage.getItem(KEY) || "{}"); } catch { return {}; }
}
/** Unlock a badge once. Shows a toast the first time. */
export function unlock(id: string) {
  const have = unlocked();
  if (have[id]) return;
  have[id] = Date.now();
  try { localStorage.setItem(KEY, JSON.stringify(have)); } catch { /* storage blocked: still show it */ }
  // also kept on the server with the rest of your profile
  void fetch("/api/profile", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ badges: { [id]: have[id] } }) }).catch(() => {});
  const b = BADGES.find((x) => x.id === id);
  if (b) window.dispatchEvent(new CustomEvent("lo:badge", { detail: b }));
}

/** Pops a badge card in from the side whenever one unlocks. */
export function BadgeToasts({ sound }: { sound: boolean }) {
  const [list, setList] = useState<(Badge & { k: number })[]>([]);
  useEffect(() => {
    const on = (e: Event) => {
      const b = (e as CustomEvent<Badge>).detail, k = Date.now() + Math.random();
      setList((l) => [...l, { ...b, k }].slice(-3));
      if (sound) beep([784, 988, 1175, 1568], 0.07);
      setTimeout(() => setList((l) => l.filter((x) => x.k !== k)), 4200);
    };
    addEventListener("lo:badge", on);
    return () => removeEventListener("lo:badge", on);
  }, [sound]);
  return (
    <div className="badge-toasts" aria-live="polite">
      {list.map((b) => (
        <div key={b.k} className="badge-toast">
          <span className="badge-e">{b.e}</span>
          <div><small>ACHIEVEMENT UNLOCKED</small><b>{b.name}</b><em>{b.how}</em></div>
        </div>
      ))}
    </div>
  );
}

/** Merge badges stored on the server into this browser (and push any this browser has that the server doesn't). */
export function syncBadges(server: Record<string, number>) {
  const local = unlocked();
  const missing = Object.fromEntries(Object.entries(local).filter(([k]) => !server[k]));
  const merged = { ...server, ...local };
  try { localStorage.setItem(KEY, JSON.stringify(merged)); } catch { /* storage blocked */ }
  if (Object.keys(missing).length) void fetch("/api/profile", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ badges: missing }) }).catch(() => {});
  return merged;
}

/** Grid of every badge for the stats screen; locked ones stay mysterious. */
export function BadgeGrid({ server }: { server?: Record<string, number> }) {
  const [have, setHave] = useState<Record<string, number>>({});
  useEffect(() => { setHave({ ...(server ?? {}), ...unlocked() }); }, [server]);
  const n = BADGES.filter((b) => have[b.id]).length;
  return (
    <div className="badges">
      <h3>Achievements <small>{n}/{BADGES.length}</small></h3>
      <ul>{BADGES.map((b, i) => (
        <li key={b.id} className={have[b.id] ? "on" : ""} style={{ animationDelay: `${i * 0.03}s` }} title={b.how}>
          <span>{have[b.id] ? b.e : "🔒"}</span><b>{have[b.id] ? b.name : "???"}</b><small>{b.how}</small>
        </li>
      ))}</ul>
    </div>
  );
}

// ------------------------------------------------------------------ Flight Director Fred
type FredEvent = { crashes: number; hits: number; basics: number; tier: string | null; hint?: boolean; skip?: boolean; rarestEver?: string };
// Fred never repeats himself back to back: each line list remembers what it said recently.
const fredUsed = new Map<string, number[]>();
const r = (xs: string[]) => {
  const k = xs[0], used = fredUsed.get(k) ?? [];
  const fresh = xs.map((_, i) => i).filter((i) => !used.includes(i));
  const i = fresh.length ? fresh[Math.floor(Math.random() * fresh.length)] : Math.floor(Math.random() * xs.length);
  fredUsed.set(k, [...used, i].slice(-Math.max(1, xs.length - 1)));
  return xs[i];
};
const FRED_IDLE = [
  "Fred: Fun fact, I've never actually been to space.", "Fred: Steady climb. I like it.", "Fred: The coffee machine is cheering for you.",
  "Fred: Keep going, the Moon isn't going to visit itself.", "Fred: I'd have said the same. Which is the problem.",
  "Fred: Somewhere, a survey analyst is taking notes.", "Fred: Don't look down. Actually, do, the view is nice.",
];
/** What Fred says after an answer, or null if he has nothing to add. */
export function fredSays(e: FredEvent): string | null {
  if (e.rarestEver) return r([`Fred: ${e.rarestEver} is the rarest answer you've EVER given. Framing this. 🖼️`, `Fred: New personal record! ${e.rarestEver} beats every answer you've ever launched.`, `Fred: Write the date down: ${e.rarestEver} is your rarest answer ever.`]);
  if (e.skip) return r(["Fred: Passing? Bold strategy. Let's see if it pays off.", "Fred: I'll mark that as 'tactical'.", "Fred: The chicken has left the launch pad.", "Fred: Skipping leg day AND prompts?", "Fred: Saving your brain for the next one. Smart. Maybe."]);
  if (e.crashes >= 5) return "Fred has left the building. 🚪";
  if (e.crashes === 4) return r(["Fred: I'm calling your mother.", "Fred: Should I just… write the answers on your hand?"]);
  if (e.crashes === 3) return r(["Fred: Three crashes. We're going to need a bigger rocket.", "Fred: Insurance is not going to cover this."]);
  if (e.crashes === 2) return r(["Fred: That's two. I'm writing this down. 📝", "Fred: Bold. Wrong, but bold."]);
  if (e.tier === "t5") return r(["Fred spilled his coffee. ☕", "Fred: NOBODY has said that. Ever. Who ARE you?", "Fred is standing on his desk applauding.", "Fred: I'm telling my kids about this one.", "Fred just fainted. Someone get a medic. 🚑"]);
  if (e.hits >= 4) return "Fred: Get this pilot a statue. 🗿";
  if (e.hits === 3) return "Fred: SOMEBODY GET THIS PILOT A MEDAL! 🏅";
  if (e.hits === 2) return r(["Fred: Okay, okay, I see you. 👀", "Fred: Two in a row. Don't get cocky."]);
  if (e.basics >= 2) return r(["Fred is falling asleep… 😴", "Fred: My grandma would've said that. Twice.", "Fred: Living dangerously, I see. Not."]);
  if (e.hint) return r(["Fred: Using a hint? I won't tell anyone. (I will.)", "Fred: Hints are just friends you pay in points.", "Fred: The navigator sends their regards."]);
  if (e.tier && Math.random() < 0.25) return r(FRED_IDLE);
  return null;
}
