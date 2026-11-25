"use client";
// Mission Control has jokes: reactions for wrong, boring and brilliant answers.
import { useMemo } from "react";
import { beep } from "./client";
import { looksLikeGibberish } from "@/lib/text";
import { Icon } from "./icons";

// Lines already shown recently, per list, so the same joke doesn't come back two answers later.
const recent = new WeakMap<readonly unknown[], number[]>();
/** A random line that wasn't used in the last few picks from this list. With a seed it's deterministic (same card, same line). */
export const pick = <T,>(xs: readonly T[], seed?: number): T => {
  if (seed !== undefined) return xs[Math.abs(seed) % xs.length];
  const used = recent.get(xs) ?? [];
  const fresh = xs.map((_, i) => i).filter((i) => !used.includes(i));
  const i = (fresh.length ? fresh : xs.map((_, j) => j))[Math.floor(Math.random() * (fresh.length || xs.length))];
  recent.set(xs, [...used, i].slice(-Math.max(1, Math.floor(xs.length * 0.7))));
  return xs[i];
};

export const CRASH_TITLES = [
  "ABORT! ABORT!", "HOUSTON, WE HAVE A PROBLEM", "LAUNCH SCRUBBED", "RAPID UNPLANNED DISASSEMBLY",
  "ENGINE SNEEZED", "WRONG PLANET", "MISSION CONTROL IS CONFUSED", "THAT'S A NO FROM ORBIT",
  "FUEL LEAK DETECTED", "THE ROCKET SAID NO", "GRAVITY WINS THIS ONE", "SPLASHDOWN (THE BAD KIND)", "NOPE, TRY AGAIN",
  "TOWER, WE HAVE A HICCUP", "ORBIT DENIED", "THE JUDGE RAISED AN EYEBROW",
];
const FAIL_EMOJI: Record<string, string> = {
  busy: "🛰️", made_up: "🦄", wrong_category: "🧭", too_vague: "🌫️", joke: "🤡", gibberish: "🐈", offensive: "🧼", none: "💥",
};
const FAIL_LABEL: Record<string, string> = {
  busy: "JUDGE WAS BUSY", made_up: "NOT A REAL THING", wrong_category: "WRONG AISLE", too_vague: "TOO VAGUE", joke: "NICE TRY, COMEDIAN",
  gibberish: "KEYBOARD SMASH", offensive: "WASH YOUR KEYBOARD", none: "CRASH",
};
export const failEmoji = (k?: string | null) => FAIL_EMOJI[k ?? ""] ?? "💥";
export const failLabel = (k?: string | null) => FAIL_LABEL[k ?? ""] ?? "CRASH";

export const MASH_LINES = [
  "Did your cat just walk across the keyboard?", "That's not a word, that's a sneeze.",
  "Mission control can't decode alien languages yet.", "Keyboard smash detected. Deep breaths.",
  "Was that a word or a password?", "Our translator just quit.", "Looks like you sat on the keyboard.", "Even the aliens are confused.",
];
export const REPEAT_LINES = [
  "Saying it again won't change the judge's mind.", "Still no. The judge has a good memory.",
  "Same answer, same crash. Try something new!", "Louder doesn't help in space. Nobody can hear you.",
  "Déjà vu! The judge remembers that one.", "Plot twist: it's still a no.", "We've seen this episode before.",
];
export const BASIC_LINES = [
  "Half the planet said that. Be weirder!", "Classic. Safe. Sleepy.", "Your rocket yawned.",
  "Even your grandma said that one.", "Points for honesty, not for originality.",
  "The crowd says hi. They said it too.", "Next time, go one step weirder.", "Comfy. Maybe too comfy.",
  "Your rocket wanted more drama.", "That's the answer on the box.", "Try the second thing you think of, not the first.",
  "Safe as houses. Houses don't fly, though.", "That one's been in orbit since forever.",
];
export const BRAIN_LINES = ["GALAXY BRAIN", "BIG BRAIN ENERGY", "ABSOLUTE LEGEND", "NOBODY SAW THAT COMING", "OFF THE CHARTS", "PURE GENIUS", "WHO TAUGHT YOU THAT"];
export const CHICKEN_LINES = ["Chickened out. 🐔", "Strategic retreat. 🏳️", "Saved your fuel for later. ⛽", "Skipped like a stone. 🪨",
  "The prompt wins this round. 🏆", "Tactical nap. 😴", "Not today, prompt. Not today. 🙅", "Moonwalked away. 🕺"];
export const OUT_OF_FUEL = ["Out of fuel. The rocket is now a very tall chair.", "Three crashes. Impressive, in a way.", "The rocket has filed a complaint.",
  "Three strikes. The rocket is taking the bus home.", "The launch pad needs a nap after that.", "Mission control is pretending that didn't happen."];

/** Keyboard mash or nonsense ("asdfgh", "sdkjfh wieur", "zzzz"). Same rules the server uses. */
export const isMash = (raw: string) => looksLikeGibberish(raw);

/** Fun sounds (tiny synth, no files). */
export const sfx = {
  trombone: () => beep([392, 370, 349, 294], 0.24), // wah wah wah waaah
  yawn: () => beep([330, 294, 262], 0.16),
  boing: () => beep([220, 440, 220], 0.07),
  brain: () => beep([523, 659, 784, 1047, 1319, 1568], 0.08),
  cluck: () => beep([880, 660, 880], 0.05),
};

/** The big crash card shown when an answer is refused. */
export function CrashCard({ text, kind, out, seed }: { text: string; kind?: string | null; out?: boolean; seed: number }) {
  const title = useMemo(() => (out ? "OUT OF FUEL" : pick(CRASH_TITLES, seed)), [out, seed]);
  return (
    <div className={`crash${out ? " out" : ""}`} key={seed} role="alert">
      <div className="crash-head"><Icon name="alert" size={16} /><span className="crash-title">{title}</span><span className="crash-kind">{out ? "No tries left" : failLabel(kind)}</span></div>
      <p>{text}</p>
    </div>
  );
}

/** A stamp slapped on result cards: BASIC for common answers, GALAXY BRAIN for rare ones. */
export function Stamp({ tier, seed }: { tier: string | null; seed: number }) {
  if (tier === "t1") return <div className="stamp basic" title={pick(BASIC_LINES, seed)}>Basic</div>;
  if (tier === "t5") return <div className="stamp brain"><Icon name="sparkle" size={12} /> {pick(BRAIN_LINES, seed).toLowerCase()}</div>;
  return null;
}
