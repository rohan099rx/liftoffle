/** Canonical form used for counting identical answers. */
export const norm = (s: string) =>
  s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase()
    .replace(/&/g, " and ").replace(/[^a-z0-9 ]+/g, " ")
    .replace(/^(the|a|an) /, "").replace(/\s+/g, " ").trim();

export const singular = (s: string) => (s.length > 4 && /[^s]s$/.test(s) ? s.slice(0, -1) : s);
export const key = (s: string) => singular(norm(s));

export function lev(a: string, b: string): number {
  if (Math.abs(a.length - b.length) > 2) return 9;
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++)
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return d[a.length][b.length];
}

/** Strip control chars / zero-width tricks and cap length before anything touches the model. */
export function cleanAnswer(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const s = raw.normalize("NFKC").replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff]/g, "")
    .replace(/\s+/g, " ").trim();
  if (!s || s.length > 60) return null;
  if (!/[\p{L}\p{N}]/u.test(s)) return null;
  return s;
}

/**
 * Obvious nonsense in Latin letters: keyboard smashes ("sdkjfh wieur", "asdfgh"), held-down keys ("aaaaa"),
 * vowel-less strings. Real words and other scripts pass. Shared by the browser and the server.
 */
export function looksLikeGibberish(raw: string): boolean {
  const s = raw.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
  if (/[^a-z0-9\s'.&-]/.test(s)) return false; // other scripts / symbols: let the AI judge decide
  const words = s.split(/[\s.&-]+/).filter((w) => /[a-z]/.test(w));
  if (!words.length) return false;
  let bad = 0;
  for (const w of words) {
    const letters = w.replace(/[^a-z]/g, "");
    const vowels = (letters.match(/[aeiouy]/g) ?? []).length;
    if (/(.)\1{3,}/.test(letters)) bad++;                                      // aaaa
    else if (/(asdf|sdfg|dfgh|fghj|ghjk|hjkl|qwer|wert|erty|rtyu|tyui|yuio|zxcv|xcvb|cvbn|vbnm|jkjk|hjhj|lkjh|poiu|mnbv|hgfd|gfds|fdsa|trew|rewq|vcxz|bvcx|nbvc|kjhg|jhgf|uytr|iuyt)/.test(letters)) bad++;
    else if (/[bcdfghjklmnpqrstvwxz]{6,}/.test(letters)) bad++;              // sdkjfh
    else if (letters.length >= 5 && vowels === 0) bad++;                     // qwrtp
  }
  // one real word plus junk is still junk; allow e.g. "BBQ" or "DVD" (short, no vowels)
  return bad > 0 && bad >= Math.ceil(words.length / 2);
}
