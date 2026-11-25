import "server-only";
import * as kv from "./store";

// Names shown on the public daily leaderboard. Letters (any language), numbers, spaces and _ . - only.
const BLOCK = /(fuck|shit|cunt|nigg|fag|bitch|whore|slut|rape|nazi|hitler|porn|dick|pussy|asshole|retard|chutiya|madarchod|bhenchod|behenchod|gandu|randi|bsdk|mc bc)/i;

export function cleanNick(s: unknown): string {
  if (typeof s !== "string") return "";
  return s.normalize("NFKC").replace(/[^\p{L}\p{M}\p{N} _.-]/gu, "").replace(/\s+/g, " ").trim().slice(0, 16);
}
/** Returns an error message, or null if the name is fine. */
export function nickProblem(n: string): string | null {
  if (n.length < 2) return "Use at least 2 letters or numbers.";
  if (BLOCK.test(n.replace(/[\s_.-]/g, ""))) return "Pick a friendlier name.";
  return null;
}
export const nickKey = (id: string) => `nick:${id}`;
export const saveNick = (id: string, n: string) => kv.set(nickKey(id), n, 365 * 86400);
export const fallbackName = (id: string) => `Launcher ${id.slice(0, 4).toUpperCase()}`;
