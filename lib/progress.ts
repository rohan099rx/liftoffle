// Levels, ranks and daily-bonus rules. Pure functions, shared by the server and the browser.

/** XP needed to go from level n to n+1. Gentle at first (a run or two), slower later. */
const step = (n: number) => 150 + (n - 1) * 75;

const RANKS = ["Cadet", "Trainee", "Pilot", "Navigator", "Engineer", "Astronaut", "Commander", "Captain", "Admiral", "Star Legend"];

export type Level = { level: number; title: string; into: number; need: number; pct: number; xp: number };

/** XP is lifetime points from solo runs (the same number the all-time leaderboard ranks). */
export function levelFor(xp: number): Level {
  let level = 1, left = Math.max(0, Math.floor(xp));
  while (left >= step(level) && level < 200) { left -= step(level); level++; }
  const need = step(level);
  return { level, title: rankTitle(level), into: left, need, pct: Math.round((left / need) * 100), xp };
}

/** A new rank title every 4 levels. */
export const rankTitle = (level: number) => RANKS[Math.min(RANKS.length - 1, Math.floor((level - 1) / 4))];

export const MAX_BOOSTS = 5;

/** What the daily bonus gives on day `n` of a check-in streak: boosts, every 7th day is a big one. */
export function dailyReward(n: number): { boosts: number; label: string } {
  if (n % 7 === 0) return { boosts: 3, label: "Week streak jackpot" };
  if (n % 3 === 0) return { boosts: 2, label: "Double fuel" };
  return { boosts: 1, label: "Daily fuel" };
}

/** Monday (UTC) of the week containing `t`, as YYYY-MM-DD: the key for the weekly board. */
export function weekKey(t = Date.now()): string {
  const d = new Date(t); d.setUTCHours(0, 0, 0, 0);
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  return d.toISOString().slice(0, 10);
}
