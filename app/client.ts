"use client";
// Small helpers shared by the solo game and party mode.

/**
 * JSON request with a hard timeout. Without one, a request that hangs (phone switching networks,
 * screen locked mid-request) never settles, and whatever was waiting on it, like live updates, stops for good.
 */
/**
 * GET a long-held live-update request. The server sends a space every few seconds while it waits;
 * if nothing at all arrives for `silenceMs` the connection is treated as dead and the request fails fast.
 */
export async function liveGet<T = any>(path: string, silenceMs: number, cancel?: AbortSignal): Promise<T> {
  const ac = new AbortController();
  cancel?.addEventListener("abort", () => ac.abort());
  let timer: ReturnType<typeof setTimeout> | undefined;
  const alive = () => { clearTimeout(timer); timer = setTimeout(() => ac.abort(), silenceMs); };
  alive();
  try {
    const res = await fetch(path, { cache: "no-store", signal: ac.signal });
    const reader = res.body?.getReader(); const dec = new TextDecoder(); let text = "";
    if (reader) for (;;) { alive(); const { value, done } = await reader.read(); if (done) break; text += dec.decode(value, { stream: true }); }
    const data = (() => { try { return JSON.parse(text); } catch { return {}; } })();
    const status = data.status ?? res.status;
    if (!res.ok || data.error) throw Object.assign(new Error(data.error || "Signal lost. Try again."), { status, data });
    return data as T;
  } catch (e) {
    if ((e as { status?: number }).status !== undefined) throw e;
    throw Object.assign(new Error(ac.signal.aborted ? "Mission control is slow to answer. Retrying…" : "No connection. Check your internet."), { status: 0 });
  } finally { clearTimeout(timer); }
}

export async function api<T = any>(path: string, payload?: unknown, timeoutMs = 15000, cancel?: AbortSignal): Promise<T> {
  let res: Response;
  const ac = new AbortController();
  cancel?.addEventListener("abort", () => ac.abort());
  const timer = setTimeout(() => ac.abort(Object.assign(new Error("timeout"), { name: "TimeoutError" })), timeoutMs);
  try {
    res = await fetch(path, payload === undefined ? { cache: "no-store", signal: ac.signal } : {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload), cache: "no-store", signal: ac.signal,
    });
  } catch (e) {
    clearTimeout(timer);
    const timedOut = (e as Error).name === "TimeoutError" || (e as Error).name === "AbortError";
    throw Object.assign(new Error(timedOut ? "Mission control is slow to answer. Retrying…" : "No connection. Check your internet."), { status: 0 });
  }
  const data = await res.json().catch(() => ({}));
  clearTimeout(timer);
  if (!res.ok) throw Object.assign(new Error(data.error || "Signal lost. Try again."), { status: res.status, data });
  return data as T;
}

// tiny synth so there are no audio files to load
let actx: AudioContext | null = null;
export function beep(freqs: number[], dur = 0.09) {
  try {
    actx ??= new AudioContext();
    freqs.forEach((f, i) => {
      const o = actx!.createOscillator(), g = actx!.createGain(), t = actx!.currentTime + i * dur;
      o.type = "triangle"; o.frequency.value = f; g.gain.setValueAtTime(0.08, t); g.gain.exponentialRampToValueAtTime(0.0001, t + dur * 1.6);
      o.connect(g).connect(actx!.destination); o.start(t); o.stop(t + dur * 1.7);
    });
  } catch { /* audio blocked */ }
}

