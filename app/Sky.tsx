"use client";
import { useEffect, useRef } from "react";

export const MAX_SCORE = 700;
export const MILESTONES: [number, string][] = [
  [0, "the launch pad"], [1, "top of the tallest building"], [12, "airliners cruise here"], [39, "highest skydive ever"],
  [100, "THE KÁRMÁN LINE · space begins"], [408, "the ISS orbits here"], [2000, "edge of low Earth orbit"],
  [20200, "GPS satellites"], [35786, "geostationary orbit"], [384400, "THE MOON"], [1.5e6, "James Webb telescope"],
  [5.5e7, "Mars at its closest"], [1.5e8, "one astronomical unit"], [6.3e8, "JUPITER · a perfect launch"],
];
export const altFor = (s: number) => (s <= 0 ? 0 : Math.pow(10, (s / MAX_SCORE) * Math.log10(6.3e8)));
export const zoneFor = (km: number) => { let z = MILESTONES[0][1]; for (const [k, l] of MILESTONES) if (km >= k) z = l; return z; };
export const fmtKm = (km: number) =>
  km < 1 ? Math.round(km * 1000) + " m" : km < 1e4 ? Math.round(km).toLocaleString() + " km" :
  km < 1e6 ? Math.round(km / 1000).toLocaleString() + "k km" : (km / 1e6).toFixed(km < 1e7 ? 1 : 0) + "M km";

/** Things you fly past, at their real altitudes. Passing one for the first time adds it to your Sky Log. */
export const SIGHTS: { id: string; km: number; name: string; x: number }[] = [
  { id: "pigeons", km: 0.03, name: "A flock of pigeons", x: 0.28 },
  { id: "balloon", km: 0.15, name: "Someone's lost party balloon", x: 0.7 },
  { id: "hotair", km: 0.45, name: "Hot-air balloons", x: 0.24 },
  { id: "paraglider", km: 1.6, name: "A paraglider", x: 0.74 },
  { id: "geese", km: 6, name: "Migrating geese", x: 0.3 },
  { id: "airliner", km: 11, name: "An airliner at cruising height", x: 0.68 },
  { id: "weather", km: 25, name: "A weather balloon", x: 0.26 },
  { id: "skydiver", km: 39, name: "A record-breaking skydiver", x: 0.72 },
  { id: "aurora", km: 160, name: "The northern lights", x: 0.5 },
  { id: "iss", km: 408, name: "The International Space Station", x: 0.5 },
  { id: "hubble", km: 1500, name: "The Hubble telescope", x: 0.3 },
  { id: "gps", km: 20200, name: "A GPS satellite", x: 0.7 },
  { id: "geo", km: 35786, name: "A weather satellite", x: 0.25 },
  { id: "moon", km: 384400, name: "The Moon", x: 0.8 },
  { id: "webb", km: 1.5e6, name: "The James Webb telescope", x: 0.3 },
  { id: "comet", km: 1.2e7, name: "A passing comet", x: 0.66 },
  { id: "mars", km: 5.5e7, name: "Mars", x: 0.2 },
  { id: "asteroids", km: 2.6e8, name: "The asteroid belt", x: 0.5 },
  { id: "jupiter", km: 6.3e8, name: "Jupiter", x: 0.78 },
];

const TIER_COLOR: Record<string, string> = { t1: "#a3acc9", t2: "#67c7f5", t3: "#6ee7a8", t4: "#fcd34d", t5: "#f472d0" };

// sky colour by altitude level (log10 km)
const SKY: [number, [number, number, number]][] = [
  [-0.2, [92, 78, 140]], [0.25, [56, 54, 118]], [0.8, [32, 34, 86]], [1.3, [17, 18, 52]], [1.8, [9, 10, 30]], [2.3, [7, 8, 20]],
];
const skyAt = (l: number) => {
  if (l <= SKY[0][0]) return SKY[0][1];
  for (let i = 1; i < SKY.length; i++) if (l <= SKY[i][0]) {
    const [a, ca] = SKY[i - 1], [b, cb] = SKY[i], t = (l - a) / (b - a);
    return ca.map((c, j) => Math.round(c + (cb[j] - c) * t)) as [number, number, number];
  }
  return SKY[SKY.length - 1][1];
};
const rgb = (c: number[], a = 1) => `rgba(${c[0]},${c[1]},${c[2]},${a})`;
const clamp = (v: number, lo = 0, hi = 1) => Math.min(hi, Math.max(lo, v));

type P = { x: number; y: number; vx: number; vy: number; life: number; max: number; size: number; kind: "fire" | "spark" | "smoke"; color?: string };

/** Full-screen animated sky. Altitude uses a log scale so every tier visibly moves the rocket. */
export default function Sky({ score, boostKey, boostTier, crashKey = 0, onAlt, onSpot }: { score: number; boostKey: number; boostTier?: string | null; crashKey?: number; onAlt?: (km: number) => void; onSpot?: (id: string) => void }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const target = useRef(altFor(score));
  const boost = useRef({ v: 0, tier: "t1", fresh: false });
  const cb = useRef(onAlt);
  cb.current = onAlt;
  const spotCb = useRef(onSpot);
  spotCb.current = onSpot;
  useEffect(() => { target.current = altFor(score); }, [score]);
  useEffect(() => { if (boostKey) boost.current = { v: 1, tier: boostTier || "t1", fresh: true }; }, [boostKey, boostTier]);
  // a wrong answer: the rocket sputters, shakes and coughs out black smoke
  const crash = useRef({ t: 99, fresh: false });
  useEffect(() => { if (crashKey) crash.current = { t: 0, fresh: true }; }, [crashKey]);

  useEffect(() => {
    const cv = ref.current!, ctx = cv.getContext("2d")!;
    const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
    let W = 0, H = 0, DPR = 1, raf = 0, shown = target.current, last = performance.now(), lastReport = -1;
    // adaptive quality: if this device can't hold ~35fps, switch to a lighter sky so the game stays responsive
    let low = false, sampleFrames = 0, sampleTime = 0, skip = false;
    let prevL = Math.log10(shown + 1), lastMajor = -1, lastReportAt = 0, prevSightL = Math.log10(shown + 1);
    MILESTONES.forEach(([km, l], i) => { if (shown >= km && km > 0 && l === l.toUpperCase()) lastMajor = i; });
    let stars: { x: number; y: number; r: number; a: number; layer: number }[] = [];
    let clouds: { km: number; x: number; s: number; v: number; img: HTMLCanvasElement }[] = [];
    let skyline: { far: HTMLCanvasElement; near: HTMLCanvasElement } | null = null;
    let font = "ui-sans-serif,system-ui,sans-serif";
    try { font = getComputedStyle(document.body).fontFamily || font; } catch { /* keep default */ }
    let city: { x: number; w: number; h: number; lit: number[] }[] = [];
    const parts: P[] = [];
    const meteors: { x: number; y: number; vx: number; vy: number; life: number }[] = [];
    const rings: { r: number; life: number; color: string }[] = [];
    let banner: { text: string; t: number } | null = null;

    const resize = () => {
      // render below native resolution: the sky is soft anyway, and it is ~2-4x less work per frame
      DPR = Math.min(1.25, devicePixelRatio || 1) * (innerWidth * innerHeight > 1.6e6 ? 0.8 : 1) * (low ? 0.6 : 1);
      W = cv.width = Math.round(innerWidth * DPR); H = cv.height = Math.round(innerHeight * DPR);
      stars = Array.from({ length: low ? 80 : 180 }, () => ({ x: Math.random(), y: Math.random(), r: Math.random() * 1.3 + 0.3, a: Math.random() * 6, layer: Math.floor(Math.random() * 3) }));
      // soft, hazy cloud banks: drawn once to an offscreen canvas, then just blitted each frame
      const makeCloud = () => {
        const cw = Math.round(260 * DPR), ch = Math.round(90 * DPR), c = document.createElement("canvas"); c.width = cw; c.height = ch;
        const x2 = c.getContext("2d")!;
        for (let i = 0; i < 9; i++) {
          const px = cw * (0.15 + Math.random() * 0.7), py = ch * (0.45 + (Math.random() - 0.5) * 0.35), r = ch * (0.22 + Math.random() * 0.3);
          const g = x2.createRadialGradient(px, py, 0, px, py, r);
          g.addColorStop(0, "rgba(214,196,236,.22)"); g.addColorStop(0.6, "rgba(190,170,225,.1)"); g.addColorStop(1, "rgba(190,170,225,0)");
          x2.fillStyle = g; x2.beginPath(); x2.ellipse(px, py, r * 1.8, r, 0, 0, 7); x2.fill();
        }
        return c;
      };
      clouds = Array.from({ length: 12 }, () => ({ km: Math.pow(10, 0.2 + Math.random() * 0.9), x: Math.random(), s: 0.7 + Math.random() * 0.9, v: (Math.random() - 0.5) * 0.004, img: makeCloud() }));
      // two-layer skyline silhouette, also pre-rendered
      const makeCity = (minH: number, maxH: number, color: string, windows: number) => {
        const c = document.createElement("canvas"); c.width = W; c.height = Math.round(maxH * DPR) + 4; const x2 = c.getContext("2d")!;
        const base = c.height;
        for (let x = 0; x < W; ) {
          const w = (16 + Math.random() * 40) * DPR, h = (minH + Math.random() * (maxH - minH)) * DPR;
          x2.fillStyle = color; x2.fillRect(x, base - h, w, h);
          if (Math.random() < 0.25) x2.fillRect(x + w * 0.45, base - h - 6 * DPR, 1.2 * DPR, 6 * DPR); // antenna
          for (let wy = base - h + 5 * DPR; wy < base - 4 * DPR; wy += 7 * DPR)
            for (let wx = x + 3 * DPR; wx < x + w - 3 * DPR; wx += 6 * DPR)
              if (Math.random() < windows) { x2.fillStyle = `rgba(255,${190 + Math.random() * 40},${120 + Math.random() * 60},${0.35 + Math.random() * 0.45})`; x2.fillRect(wx, wy, 1.6 * DPR, 2 * DPR); }
          x += w + (Math.random() < 0.3 ? 4 : 1) * DPR;
        }
        return c;
      };
      skyline = { far: makeCity(30, 95, "#1a1838", 0.05), near: makeCity(12, 60, "#0b0a1c", 0.12) };
      city = [];
    };
    resize(); addEventListener("resize", resize);
    const lg = (km: number) => Math.log10(km + 1);

    const drawBody = (x: number, y: number, r: number, kind: "moon" | "mars" | "jupiter") => {
      ctx.save();
      const glow = ctx.createRadialGradient(x, y, r * 0.8, x, y, r * 2.2);
      const gc = kind === "moon" ? "220,225,255" : kind === "mars" ? "255,120,80" : "255,200,150";
      glow.addColorStop(0, `rgba(${gc},.25)`); glow.addColorStop(1, `rgba(${gc},0)`);
      ctx.fillStyle = glow; ctx.beginPath(); ctx.arc(x, y, r * 2.2, 0, 7); ctx.fill();
      const g = ctx.createRadialGradient(x - r * 0.4, y - r * 0.4, r * 0.1, x, y, r);
      if (kind === "moon") { g.addColorStop(0, "#f4f4f8"); g.addColorStop(1, "#8d90a3"); }
      else if (kind === "mars") { g.addColorStop(0, "#ffae80"); g.addColorStop(1, "#9c3a1c"); }
      else { g.addColorStop(0, "#f7dcb4"); g.addColorStop(1, "#a4683e"); }
      ctx.fillStyle = g; ctx.beginPath(); ctx.arc(x, y, r, 0, 7); ctx.fill();
      ctx.clip();
      if (kind === "moon") {
        ctx.fillStyle = "rgba(90,92,110,.35)";
        for (const [dx, dy, rr] of [[-.3, -.2, .18], [.25, .1, .22], [-.1, .4, .12], [.4, -.4, .1]]) { ctx.beginPath(); ctx.arc(x + dx * r, y + dy * r, rr * r, 0, 7); ctx.fill(); }
      } else if (kind === "jupiter") {
        for (let i = -4; i <= 4; i++) { ctx.fillStyle = i % 2 ? "rgba(140,80,40,.35)" : "rgba(255,240,220,.2)"; ctx.fillRect(x - r, y + i * r * 0.2 - r * 0.07, r * 2, r * 0.13); }
        ctx.fillStyle = "rgba(190,80,50,.75)"; ctx.beginPath(); ctx.ellipse(x + r * 0.3, y + r * 0.3, r * 0.2, r * 0.11, 0, 0, 7); ctx.fill();
      } else { ctx.fillStyle = "rgba(255,255,255,.55)"; ctx.beginPath(); ctx.ellipse(x, y - r * 0.92, r * 0.45, r * 0.16, 0, 0, 7); ctx.fill(); }
      // terminator shadow
      const sh = ctx.createLinearGradient(x - r, y - r, x + r, y + r); sh.addColorStop(0.45, "rgba(0,0,10,0)"); sh.addColorStop(1, "rgba(0,0,10,.65)");
      ctx.fillStyle = sh; ctx.fillRect(x - r, y - r, r * 2, r * 2);
      ctx.restore();
    };

    const drawSight = (id: string, x: number, y: number, d: number, now: number, atmo: number) => {
      ctx.save(); ctx.translate(x, y);
      const t = now / 1000;
      switch (id) {
        case "pigeons": case "geese": {
          const n = id === "geese" ? 9 : 6, drift = ((t * (id === "geese" ? 14 : 22)) % 260) - 130;
          ctx.strokeStyle = id === "geese" ? "rgba(30,28,48,.85)" : "rgba(40,36,64,.8)"; ctx.lineWidth = 1.6 * d; ctx.lineCap = "round";
          for (let i = 0; i < n; i++) {
            // geese fly in a V; pigeons in a loose flock
            const bx = (id === "geese" ? -Math.abs(i - 4) * 14 : (i * 37) % 60 - 30) * d + drift * d, by = (id === "geese" ? -Math.abs(i - 4) * -7 : ((i * 53) % 30) - 15) * d;
            const flap = Math.sin(t * 9 + i * 1.7) * 4 * d, w = 6 * d;
            ctx.beginPath(); ctx.moveTo(bx - w, by - flap); ctx.quadraticCurveTo(bx - w / 2, by - 2 * d, bx, by); ctx.quadraticCurveTo(bx + w / 2, by - 2 * d, bx + w, by - flap); ctx.stroke();
          }
          break;
        }
        case "balloon": {
          const sway = Math.sin(t * 1.3) * 6 * d; ctx.translate(sway, Math.sin(t * 0.9) * 3 * d);
          ctx.strokeStyle = "rgba(230,230,255,.5)"; ctx.lineWidth = 0.8 * d; ctx.beginPath(); ctx.moveTo(0, 9 * d); ctx.quadraticCurveTo(4 * d, 20 * d, -2 * d, 30 * d); ctx.stroke();
          const g = ctx.createRadialGradient(-3 * d, -4 * d, 1, 0, 0, 10 * d); g.addColorStop(0, "#ff9aa8"); g.addColorStop(1, "#d2304a");
          ctx.fillStyle = g; ctx.beginPath(); ctx.ellipse(0, 0, 7.5 * d, 9.5 * d, 0, 0, 7); ctx.fill();
          break;
        }
        case "hotair": {
          for (const [ox, oy, sc, hue] of [[0, 0, 1, 0], [70, 34, 0.6, 1], [-60, 46, 0.45, 2]] as const) {
            ctx.save(); ctx.translate(ox * d + Math.sin(t * 0.5 + hue) * 5 * d, oy * d + Math.sin(t * 0.7 + hue) * 4 * d); ctx.scale(sc, sc);
            const cols = [["#ff6b6b", "#ffd166"], ["#4cc9f0", "#f1faee"], ["#b388ff", "#ffb4e6"]][hue];
            ctx.save(); ctx.beginPath(); ctx.moveTo(0, 20 * d); ctx.bezierCurveTo(-24 * d, 2 * d, -22 * d, -26 * d, 0, -26 * d); ctx.bezierCurveTo(22 * d, -26 * d, 24 * d, 2 * d, 0, 20 * d); ctx.clip();
            for (let i = -3; i <= 3; i++) { ctx.fillStyle = cols[(i + 3) % 2]; ctx.fillRect(i * 7 * d - 3.5 * d, -30 * d, 7 * d, 52 * d); }
            const sh = ctx.createLinearGradient(-22 * d, 0, 22 * d, 0); sh.addColorStop(0, "rgba(0,0,20,.35)"); sh.addColorStop(0.4, "rgba(255,255,255,.12)"); sh.addColorStop(1, "rgba(0,0,20,.45)");
            ctx.fillStyle = sh; ctx.fillRect(-26 * d, -30 * d, 52 * d, 52 * d); ctx.restore();
            ctx.strokeStyle = "rgba(60,40,30,.9)"; ctx.lineWidth = 0.8 * d; ctx.beginPath(); ctx.moveTo(-5 * d, 20 * d); ctx.lineTo(-4 * d, 27 * d); ctx.moveTo(5 * d, 20 * d); ctx.lineTo(4 * d, 27 * d); ctx.stroke();
            ctx.fillStyle = "#6b4426"; ctx.fillRect(-4.5 * d, 27 * d, 9 * d, 6 * d);
            if (Math.sin(t * 3 + hue) > 0.6) { ctx.fillStyle = "rgba(255,190,90,.8)"; ctx.beginPath(); ctx.arc(0, 23 * d, 2.2 * d, 0, 7); ctx.fill(); }
            ctx.restore();
          }
          break;
        }
        case "paraglider": {
          ctx.translate(Math.sin(t * 0.4) * 30 * d, Math.sin(t * 0.8) * 4 * d);
          ctx.fillStyle = "#ffb703"; ctx.beginPath(); ctx.moveTo(-22 * d, 0); ctx.quadraticCurveTo(0, -14 * d, 22 * d, 0); ctx.quadraticCurveTo(0, -8 * d, -22 * d, 0); ctx.fill();
          ctx.strokeStyle = "rgba(230,230,255,.45)"; ctx.lineWidth = 0.6 * d; ctx.beginPath();
          for (const ex of [-20, -8, 8, 20]) { ctx.moveTo(ex * d, -1 * d); ctx.lineTo(0, 18 * d); } ctx.stroke();
          ctx.fillStyle = "#1d1b33"; ctx.beginPath(); ctx.arc(0, 20 * d, 2.4 * d, 0, 7); ctx.fill();
          break;
        }
        case "airliner": {
          const px = ((t * 40) % 500) - 250; ctx.translate(px * d, 0);
          const trail = ctx.createLinearGradient(-200 * d, 0, -14 * d, 0); trail.addColorStop(0, "rgba(255,255,255,0)"); trail.addColorStop(1, `rgba(255,255,255,${0.5 * atmo + 0.1})`);
          ctx.strokeStyle = trail; ctx.lineWidth = 2 * d; ctx.beginPath(); ctx.moveTo(-200 * d, -1.5 * d); ctx.lineTo(-14 * d, -1.5 * d); ctx.moveTo(-200 * d, 2.5 * d); ctx.lineTo(-14 * d, 2.5 * d); ctx.stroke();
          ctx.fillStyle = "#e7e9f6"; ctx.beginPath(); ctx.ellipse(0, 0, 18 * d, 3 * d, 0, 0, 7); ctx.fill();
          ctx.fillStyle = "#b9bfd9"; ctx.beginPath(); ctx.moveTo(-2 * d, 0); ctx.lineTo(-9 * d, 10 * d); ctx.lineTo(-5 * d, 10 * d); ctx.lineTo(5 * d, 0); ctx.fill();
          ctx.beginPath(); ctx.moveTo(-14 * d, 0); ctx.lineTo(-19 * d, -8 * d); ctx.lineTo(-16 * d, -8 * d); ctx.lineTo(-10 * d, 0); ctx.fill();
          ctx.fillStyle = Math.sin(t * 6) > 0.7 ? "#ff4d4d" : "rgba(255,77,77,.2)"; ctx.beginPath(); ctx.arc(-2 * d, 9 * d, 1.3 * d, 0, 7); ctx.fill();
          break;
        }
        case "weather": {
          ctx.translate(Math.sin(t * 0.6) * 4 * d, 0);
          const g = ctx.createRadialGradient(-5 * d, -6 * d, 1, 0, 0, 16 * d); g.addColorStop(0, "#ffffff"); g.addColorStop(1, "#a9b0d0");
          ctx.fillStyle = g; ctx.beginPath(); ctx.arc(0, 0, 14 * d, 0, 7); ctx.fill();
          ctx.strokeStyle = "rgba(230,230,255,.5)"; ctx.lineWidth = 0.7 * d; ctx.beginPath(); ctx.moveTo(0, 14 * d); ctx.lineTo(0, 34 * d); ctx.stroke();
          ctx.fillStyle = "#ff8f5a"; ctx.fillRect(-4 * d, 34 * d, 8 * d, 6 * d);
          break;
        }
        case "skydiver": {
          ctx.translate(Math.sin(t * 0.5) * 10 * d, Math.sin(t * 1.1) * 3 * d); ctx.rotate(Math.sin(t * 0.7) * 0.15);
          ctx.strokeStyle = "#f1f3ff"; ctx.lineWidth = 2 * d; ctx.lineCap = "round"; ctx.beginPath();
          ctx.moveTo(-9 * d, -5 * d); ctx.lineTo(0, 0); ctx.lineTo(9 * d, -5 * d); ctx.moveTo(0, 0); ctx.lineTo(0, 9 * d); ctx.moveTo(0, 9 * d); ctx.lineTo(-6 * d, 16 * d); ctx.moveTo(0, 9 * d); ctx.lineTo(6 * d, 16 * d); ctx.stroke();
          ctx.fillStyle = "#ffd166"; ctx.beginPath(); ctx.arc(0, -4 * d, 3.2 * d, 0, 7); ctx.fill();
          break;
        }
        case "aurora": {
          ctx.globalCompositeOperation = "lighter";
          for (let band = 0; band < 3; band++) {
            const col = band === 1 ? "180,120,255" : "90,255,170";
            ctx.beginPath();
            for (let i = 0; i <= 40; i++) { const px = (i / 40 - 0.5) * W * 1.1, py = Math.sin(i * 0.35 + t * 0.6 + band) * 18 * d + band * 14 * d; i ? ctx.lineTo(px, py) : ctx.moveTo(px, py); }
            for (let i = 40; i >= 0; i--) { const px = (i / 40 - 0.5) * W * 1.1, py = Math.sin(i * 0.35 + t * 0.6 + band) * 18 * d + band * 14 * d - (50 + 20 * Math.sin(i * 0.2 + t)) * d; ctx.lineTo(px, py); }
            const g = ctx.createLinearGradient(0, -60 * d, 0, 40 * d); g.addColorStop(0, `rgba(${col},0)`); g.addColorStop(0.7, `rgba(${col},.16)`); g.addColorStop(1, `rgba(${col},0)`);
            ctx.fillStyle = g; ctx.fill();
          }
          ctx.globalCompositeOperation = "source-over";
          break;
        }
        case "hubble": case "gps": case "geo": {
          ctx.rotate(Math.sin(t * 0.3) * 0.2 + (id === "gps" ? 0.5 : 0));
          const body = id === "hubble" ? "#d5d9e8" : id === "gps" ? "#e8c46a" : "#c8cde0";
          ctx.fillStyle = "#3f6fd1";
          ctx.fillRect(-30 * d, -6 * d, 16 * d, 12 * d); ctx.fillRect(14 * d, -6 * d, 16 * d, 12 * d);
          ctx.strokeStyle = "rgba(255,255,255,.25)"; ctx.lineWidth = 0.6 * d; ctx.beginPath();
          for (const ox of [-26, -22, -18, 18, 22, 26]) { ctx.moveTo(ox * d, -6 * d); ctx.lineTo(ox * d, 6 * d); } ctx.stroke();
          ctx.fillStyle = body;
          if (id === "hubble") { ctx.fillRect(-7 * d, -15 * d, 14 * d, 30 * d); ctx.fillStyle = "#555b78"; ctx.beginPath(); ctx.arc(0, -15 * d, 7 * d, Math.PI, 0); ctx.fill(); }
          else { ctx.fillRect(-8 * d, -8 * d, 16 * d, 16 * d); ctx.fillStyle = "#fff"; ctx.beginPath(); ctx.arc(0, 12 * d, 4 * d, 0, Math.PI); ctx.fill(); }
          ctx.fillStyle = Math.sin(t * 4) > 0 ? "#7CFFB2" : "rgba(124,255,178,.2)"; ctx.beginPath(); ctx.arc(0, 0, 1.6 * d, 0, 7); ctx.fill();
          break;
        }
        case "webb": {
          ctx.rotate(Math.sin(t * 0.2) * 0.15);
          ctx.fillStyle = "rgba(200,170,255,.35)"; ctx.beginPath(); ctx.moveTo(-36 * d, 16 * d); ctx.lineTo(36 * d, 16 * d); ctx.lineTo(24 * d, 26 * d); ctx.lineTo(-24 * d, 26 * d); ctx.fill();
          const hex = (cx: number, cy: number, r: number) => { ctx.beginPath(); for (let i = 0; i < 6; i++) { const a = Math.PI / 6 + (i * Math.PI) / 3; ctx[i ? "lineTo" : "moveTo"](cx + r * Math.cos(a), cy + r * Math.sin(a)); } ctx.fill(); };
          const r = 5.2 * d;
          for (const [q, rr] of [[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1], [1, -1], [-1, 1], [2, -1], [-2, 1], [1, 1], [-1, -1], [2, 0], [-2, 0], [1, -2], [-1, 2], [0, 2], [0, -2], [2, -2]] as const) {
            const hx = r * Math.sqrt(3) * (q + rr / 2), hy = r * 1.5 * rr;
            if (Math.hypot(hx, hy) > 16 * d) continue;
            const g = ctx.createLinearGradient(hx - r, hy - r, hx + r, hy + r); g.addColorStop(0, "#ffe9a3"); g.addColorStop(1, "#c88f1c");
            ctx.fillStyle = g; hex(hx, hy, r * 0.94);
          }
          ctx.fillStyle = `rgba(255,220,140,${0.25 + 0.15 * Math.sin(t * 2)})`; ctx.beginPath(); ctx.arc(0, 0, 22 * d, 0, 7); ctx.fill();
          break;
        }
        case "comet": {
          ctx.rotate(-0.5);
          ctx.globalCompositeOperation = "lighter";
          const tail = ctx.createLinearGradient(0, 0, 160 * d, 0); tail.addColorStop(0, "rgba(160,220,255,.7)"); tail.addColorStop(1, "rgba(160,220,255,0)");
          ctx.fillStyle = tail; ctx.beginPath(); ctx.moveTo(0, -5 * d); ctx.quadraticCurveTo(90 * d, -16 * d, 160 * d, -26 * d); ctx.lineTo(160 * d, 22 * d); ctx.quadraticCurveTo(90 * d, 12 * d, 0, 5 * d); ctx.fill();
          const head = ctx.createRadialGradient(0, 0, 0, 0, 0, 10 * d); head.addColorStop(0, "#ffffff"); head.addColorStop(1, "rgba(160,220,255,0)");
          ctx.fillStyle = head; ctx.beginPath(); ctx.arc(0, 0, 10 * d, 0, 7); ctx.fill();
          ctx.globalCompositeOperation = "source-over";
          break;
        }
        case "asteroids": {
          for (let i = 0; i < 26; i++) {
            const ax = (((i * 97.3 + t * (8 + (i % 5) * 3)) % 1.2) - 0.6) * W, ay = (((i * 41) % 90) - 45) * d, ar = (2 + (i * 13) % 7) * d;
            ctx.fillStyle = i % 3 ? "#7a6f66" : "#9b8c7c"; ctx.beginPath(); ctx.ellipse(ax, ay, ar * 1.3, ar, i, 0, 7); ctx.fill();
          }
          break;
        }
      }
      ctx.restore();
    };

    const drawRocket = (rx: number, ry: number, s: number, tilt: number, thrust: number, now: number) => {
      ctx.save(); ctx.translate(rx, ry); ctx.rotate(tilt);
      // flame (drawn first, behind body)
      if (thrust > 0.02) {
        ctx.globalCompositeOperation = "lighter";
        const len = (14 + thrust * 46) * (0.85 + 0.3 * Math.random()) * s;
        const layers: [string, number, number][] = [["rgba(255,90,60,.55)", 1, 9], ["rgba(255,170,70,.8)", 0.72, 6.5], ["rgba(255,245,200,.95)", 0.42, 3.6]];
        for (const [c, lf, wd] of layers) {
          ctx.fillStyle = c; ctx.beginPath(); ctx.moveTo(-wd * s, 20 * s);
          ctx.quadraticCurveTo(-wd * 0.8 * s, 20 * s + len * lf * 0.5, 0, 20 * s + len * lf);
          ctx.quadraticCurveTo(wd * 0.8 * s, 20 * s + len * lf * 0.5, wd * s, 20 * s); ctx.fill();
        }
        const halo = ctx.createRadialGradient(0, 26 * s, 0, 0, 26 * s, 40 * s * (0.6 + thrust));
        halo.addColorStop(0, `rgba(255,180,90,${0.35 * clamp(thrust)})`); halo.addColorStop(1, "rgba(255,120,60,0)");
        ctx.fillStyle = halo; ctx.beginPath(); ctx.arc(0, 26 * s, 40 * s * (0.6 + thrust), 0, 7); ctx.fill();
        ctx.globalCompositeOperation = "source-over";
      }
      // nozzle
      ctx.fillStyle = "#3a3f5c"; ctx.beginPath(); ctx.moveTo(-6 * s, 16 * s); ctx.lineTo(6 * s, 16 * s); ctx.lineTo(8 * s, 22 * s); ctx.lineTo(-8 * s, 22 * s); ctx.fill();
      // fins
      const fin = ctx.createLinearGradient(-18 * s, 0, 18 * s, 0); fin.addColorStop(0, "#c0344a"); fin.addColorStop(0.5, "#ff5f6d"); fin.addColorStop(1, "#c0344a");
      ctx.fillStyle = fin;
      ctx.beginPath(); ctx.moveTo(-9 * s, 2 * s); ctx.quadraticCurveTo(-19 * s, 10 * s, -18 * s, 24 * s); ctx.lineTo(-9 * s, 17 * s); ctx.fill();
      ctx.beginPath(); ctx.moveTo(9 * s, 2 * s); ctx.quadraticCurveTo(19 * s, 10 * s, 18 * s, 24 * s); ctx.lineTo(9 * s, 17 * s); ctx.fill();
      // body
      const body = ctx.createLinearGradient(-11 * s, 0, 11 * s, 0);
      body.addColorStop(0, "#9aa2c8"); body.addColorStop(0.35, "#ffffff"); body.addColorStop(0.7, "#dfe3f5"); body.addColorStop(1, "#7f88b4");
      ctx.fillStyle = body; ctx.beginPath(); ctx.moveTo(0, -32 * s);
      ctx.bezierCurveTo(13 * s, -20 * s, 11 * s, 4 * s, 9 * s, 18 * s); ctx.lineTo(-9 * s, 18 * s);
      ctx.bezierCurveTo(-11 * s, 4 * s, -13 * s, -20 * s, 0, -32 * s); ctx.fill();
      // nose cone
      ctx.save(); ctx.clip(); ctx.fillStyle = "#ff5f6d"; ctx.fillRect(-14 * s, -34 * s, 28 * s, 12 * s);
      ctx.fillStyle = "rgba(255,95,109,.9)"; ctx.fillRect(-14 * s, 11 * s, 28 * s, 2.5 * s); ctx.restore();
      // centre fin
      ctx.fillStyle = "#c0344a"; ctx.fillRect(-1.3 * s, 6 * s, 2.6 * s, 15 * s);
      // window
      ctx.fillStyle = "#3a3f5c"; ctx.beginPath(); ctx.arc(0, -8 * s, 5.4 * s, 0, 7); ctx.fill();
      const win = ctx.createRadialGradient(-1.5 * s, -9.5 * s, 0.5 * s, 0, -8 * s, 4.2 * s);
      win.addColorStop(0, "#d8f6ff"); win.addColorStop(0.5, "#5fd3ff"); win.addColorStop(1, "#1c6f9c");
      ctx.fillStyle = win; ctx.beginPath(); ctx.arc(0, -8 * s, 4.2 * s, 0, 7); ctx.fill();
      ctx.fillStyle = `rgba(255,255,255,${0.5 + 0.3 * Math.sin(now / 400)})`; ctx.beginPath(); ctx.arc(-1.6 * s, -9.6 * s, 1.1 * s, 0, 7); ctx.fill();
      ctx.restore();
    };

    const frame = (now: number) => {
      const raw = (now - last) / 1000;
      if (low && (skip = !skip)) { raf = requestAnimationFrame(frame); return; } // light mode: ~30fps
      if (!low && !document.hidden && now > 3000) { // ignore the busy first seconds of page load
        sampleFrames++; sampleTime += raw;
        if (sampleFrames === 90) { if (sampleTime / sampleFrames > 1 / 35) { low = true; resize(); } sampleFrames = 0; sampleTime = 0; }
      }
      const dt = Math.min(0.05, raw); last = now;
      // the camera climbs at a steady pace on the log scale, so every layer of sky visibly scrolls past
      if (reduce) shown = target.current;
      else {
        const cur = lg(shown), want = lg(target.current), d = want - cur;
        const step = Math.sign(d) * Math.min(Math.abs(d), Math.max(Math.abs(d) * dt * 1.6, dt * 0.35));
        shown = Math.max(0, Math.pow(10, cur + step) - 1);
      }
      const b = boost.current; b.v = Math.max(0, b.v - dt * 0.55);
      const camL = lg(shown), ppd = H * 0.42, cy = H * 0.26, yOf = (km: number) => cy - (lg(km) - camL) * ppd;
      const vel = Math.max(0, (camL - prevL) / Math.max(dt, 1e-3)); // decades per second
      const scroll = (camL - prevL) * ppd; prevL = camL;
      const atmo = 1 - clamp((camL - 1.3) / 1.0), starA = Math.max(0.35 * (1 - clamp(camL / 2)), 1 - atmo) ; // a few stars already at dusk
      const thrust = clamp((shown > 0.0005 ? 0.25 : 0.12) + vel * 1.6 + b.v * 1.2, 0, 1.6);

      ctx.save();
      if (!reduce && b.v > 0.5) ctx.translate((Math.random() - 0.5) * 3 * DPR * (b.v - 0.5) * 2, (Math.random() - 0.5) * 3 * DPR * (b.v - 0.5) * 2);

      // --- sky gradient
      const g = ctx.createLinearGradient(0, 0, 0, H);
      for (let i = 0; i <= 6; i++) { const y = (i / 6) * H; g.addColorStop(i / 6, rgb(skyAt(camL + (cy - y) / ppd))); }
      ctx.fillStyle = g; ctx.fillRect(-20, -20, W + 40, H + 40);

      // --- tier flash
      if (b.v > 0 && (b.tier === "t4" || b.tier === "t5")) { ctx.fillStyle = TIER_COLOR[b.tier]; ctx.globalAlpha = 0.08 * b.v * b.v; ctx.fillRect(-20, -20, W + 40, H + 40); ctx.globalAlpha = 1; }

      // --- stars (3 parallax layers, stretch into streaks when moving fast)
      if (starA > 0) {
        ctx.fillStyle = "#fff"; ctx.strokeStyle = "#fff";
        for (const s of stars) {
          const f = [0.06, 0.14, 0.28][s.layer];
          const y = (((s.y * H + camL * ppd * f) % H) + H) % H, x = s.x * W, r = s.r * DPR * (0.7 + s.layer * 0.25);
          ctx.globalAlpha = starA * (0.35 + 0.65 * Math.abs(Math.sin(now / 900 + s.a)));
          const streak = reduce ? 0 : Math.min(60 * DPR, scroll * f * 4);
          if (streak > 2) { ctx.lineWidth = r; ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x, y - streak); ctx.stroke(); }
          else { ctx.beginPath(); ctx.arc(x, y, r, 0, 7); ctx.fill(); }
        }
        ctx.globalAlpha = 1;
        // shooting stars
        if (!reduce && starA > 0.6 && Math.random() < dt * 0.25) meteors.push({ x: Math.random() * W, y: Math.random() * H * 0.5, vx: (Math.random() < 0.5 ? -1 : 1) * (500 + Math.random() * 400) * DPR, vy: (220 + Math.random() * 180) * DPR, life: 1 });
        for (let i = meteors.length - 1; i >= 0; i--) {
          const m = meteors[i]; m.x += m.vx * dt; m.y += m.vy * dt; m.life -= dt * 1.4;
          if (m.life <= 0) { meteors.splice(i, 1); continue; }
          const tail = ctx.createLinearGradient(m.x, m.y, m.x - m.vx * 0.12, m.y - m.vy * 0.12);
          tail.addColorStop(0, `rgba(255,255,255,${m.life * starA})`); tail.addColorStop(1, "rgba(255,255,255,0)");
          ctx.strokeStyle = tail; ctx.lineWidth = 1.6 * DPR; ctx.beginPath(); ctx.moveTo(m.x, m.y); ctx.lineTo(m.x - m.vx * 0.12, m.y - m.vy * 0.12); ctx.stroke();
        }
      }

      // --- celestial bodies at their real milestones
      const bodies: [number, number, number, "moon" | "mars" | "jupiter"][] = [[384400, 0.8, 34, "moon"], [5.5e7, 0.2, 26, "mars"], [6.3e8, 0.78, 58, "jupiter"]];
      for (const [km, fx, r, kind] of bodies) { const y = yOf(km), rr = r * DPR; if (y > -rr * 3 && y < H + rr * 3) drawBody(W * fx, y, rr, kind); }
      // ISS: little satellite gliding across
      { const y = yOf(408); if (y > -40 && y < H + 40) {
        const x = ((now / 60) % (W + 200 * DPR)) - 100 * DPR; ctx.save(); ctx.translate(x, y); ctx.fillStyle = "#cfd6ff";
        ctx.fillRect(-4 * DPR, -2 * DPR, 8 * DPR, 4 * DPR); ctx.fillStyle = "#4b7bd6"; ctx.fillRect(-18 * DPR, -5 * DPR, 11 * DPR, 10 * DPR); ctx.fillRect(7 * DPR, -5 * DPR, 11 * DPR, 10 * DPR);
        ctx.fillStyle = `rgba(255,80,80,${Math.sin(now / 200) > 0 ? 1 : 0.2})`; ctx.fillRect(-1 * DPR, -4 * DPR, 2 * DPR, 2 * DPR); ctx.restore();
      } }

      // --- Earth's curve once you're in space
      const earthA = clamp((camL - 1.8) / 0.45) * (1 - clamp((camL - 6.2) / 1));
      if (earthA > 0) {
        const r = Math.max(14 * DPR, (W * 2.6) / Math.pow(10, Math.max(0, camL - 2) * 0.8));
        const cap = Math.min(2 * r, H * 0.2), ecy = H - cap + r, ecx = W / 2;
        ctx.globalAlpha = earthA;
        const atm = ctx.createRadialGradient(ecx, ecy, r * 0.98, ecx, ecy, r * 1.08 + 10 * DPR);
        atm.addColorStop(0, "rgba(95,211,255,.55)"); atm.addColorStop(1, "rgba(95,211,255,0)");
        ctx.fillStyle = atm; ctx.beginPath(); ctx.arc(ecx, ecy, r * 1.08 + 10 * DPR, 0, 7); ctx.fill();
        const eg = ctx.createRadialGradient(ecx - r * 0.3, ecy - r * 0.6, r * 0.1, ecx, ecy, r);
        eg.addColorStop(0, "#5aa8ff"); eg.addColorStop(0.6, "#1d4fa8"); eg.addColorStop(1, "#0a1e4a");
        ctx.fillStyle = eg; ctx.beginPath(); ctx.arc(ecx, ecy, r, 0, 7); ctx.fill();
        ctx.save(); ctx.clip(); ctx.fillStyle = "rgba(80,170,110,.55)";
        for (const [dx, dy, s1, s2] of [[-0.35, -0.75, 0.22, 0.08], [0.2, -0.85, 0.3, 0.07], [0.55, -0.6, 0.14, 0.1], [-0.1, -0.4, 0.18, 0.12]]) { ctx.beginPath(); ctx.ellipse(ecx + dx * r, ecy + dy * r, s1 * r, s2 * r, 0.3, 0, 7); ctx.fill(); }
        ctx.fillStyle = "rgba(255,255,255,.35)";
        for (const [dx, dy, s1] of [[-0.6, -0.7, 0.2], [0.1, -0.95, 0.25], [0.4, -0.75, 0.18]]) { ctx.beginPath(); ctx.ellipse(ecx + dx * r + ((now / 80) % 40), ecy + dy * r, s1 * r, 0.03 * r, 0, 0, 7); ctx.fill(); }
        ctx.restore(); ctx.globalAlpha = 1;
      }

      // --- clouds (parallax, fade out as the air thins)
      if (atmo > 0) for (const c of clouds) {
        const y = yOf(c.km); if (y < -120 * DPR || y > H + 120 * DPR) continue;
        c.x = (c.x + c.v * dt + 1.3) % 1.3; const w = c.img.width * c.s, h = c.img.height * c.s, x = (c.x - 0.15) * W - w / 2;
        ctx.globalAlpha = atmo; ctx.drawImage(c.img, x, y - h / 2, w, h);
      }
      ctx.globalAlpha = 1;

      // --- things you fly past
      for (const sg of SIGHTS) {
        const y = yOf(sg.km);
        // passing one on the way up: report it (the page shows "Spotted" and keeps a Sky Log)
        if (prevSightL < lg(sg.km) && camL >= lg(sg.km) && camL > prevSightL) spotCb.current?.(sg.id);
        if (y < -160 * DPR || y > H + 160 * DPR || ["iss", "moon", "mars", "jupiter"].includes(sg.id)) continue;
        drawSight(sg.id, W * sg.x, y, DPR, now, atmo);
      }
      prevSightL = camL;

      // --- ground: horizon glow, city skyline, pad
      const gy = yOf(0);
      if (gy < H + 120 * DPR) {
        // sunset band on the horizon
        const hg = ctx.createLinearGradient(0, gy - H * 0.32, 0, gy);
        hg.addColorStop(0, "rgba(255,150,140,0)"); hg.addColorStop(0.6, `rgba(244,124,150,${0.22 * atmo})`); hg.addColorStop(1, `rgba(255,170,120,${0.55 * atmo})`);
        ctx.fillStyle = hg; ctx.fillRect(0, gy - H * 0.32, W, H * 0.32);
        if (skyline) {
          ctx.globalAlpha = 0.9; ctx.drawImage(skyline.far, 0, gy - skyline.far.height + 1); ctx.globalAlpha = 1;
          ctx.drawImage(skyline.near, 0, gy - skyline.near.height + 1);
        }
        const gr = ctx.createLinearGradient(0, gy, 0, gy + 80 * DPR); gr.addColorStop(0, "#0b0a1c"); gr.addColorStop(1, "#05050d");
        ctx.fillStyle = gr; ctx.fillRect(0, gy, W, H - gy + 40);
        // low ground haze lit by the city
        const fog = ctx.createLinearGradient(0, gy, 0, gy + 160 * DPR);
        fog.addColorStop(0, "rgba(120,80,150,.28)"); fog.addColorStop(1, "rgba(60,40,90,0)");
        ctx.fillStyle = fog; ctx.fillRect(0, gy, W, 160 * DPR);
        // launch tower
        const tx = W / 2 + 30 * DPR; ctx.strokeStyle = "#3b3f63"; ctx.lineWidth = 1.5 * DPR; ctx.beginPath();
        ctx.moveTo(tx, gy); ctx.lineTo(tx, gy - 78 * DPR); ctx.moveTo(tx + 10 * DPR, gy); ctx.lineTo(tx + 10 * DPR, gy - 78 * DPR);
        for (let k = 0; k < 7; k++) { ctx.moveTo(tx, gy - k * 11 * DPR); ctx.lineTo(tx + 10 * DPR, gy - (k + 1) * 11 * DPR); }
        ctx.moveTo(tx, gy - 52 * DPR); ctx.lineTo(tx - 14 * DPR, gy - 52 * DPR); ctx.stroke();
        ctx.fillStyle = Math.sin(now / 350) > 0 ? "#ff5f5f" : "#5a1f2a"; ctx.beginPath(); ctx.arc(tx + 5 * DPR, gy - 82 * DPR, 2.5 * DPR, 0, 7); ctx.fill();
        ctx.fillStyle = "#1f2140"; ctx.fillRect(W / 2 - 34 * DPR, gy - 4 * DPR, 68 * DPR, 5 * DPR);
      }

      // --- milestone lines
      ctx.font = `500 ${10.5 * DPR}px ${font}`; ctx.textBaseline = "middle";
      MILESTONES.forEach(([km, label], i) => {
        const y = yOf(km); if (km === 0 || y < -20 || y > H + 20) return;
        const major = label === label.toUpperCase(), right = i % 2 === 1, text = `${label} · ${fmtKm(km)}`;
        ctx.strokeStyle = major ? "rgba(244,114,208,.35)" : "rgba(255,255,255,.09)"; ctx.lineWidth = DPR * 0.8; ctx.setLineDash([2 * DPR, 6 * DPR]);
        ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke(); ctx.setLineDash([]);
        ctx.fillStyle = major ? "rgba(249,168,224,.85)" : "rgba(220,224,245,.45)"; ctx.textAlign = right ? "right" : "left";
        ctx.fillText(text.toUpperCase(), right ? W - 16 * DPR : 16 * DPR, y - 9 * DPR);
      });
      // banner when crossing a major milestone
      let majorIdx = -1; MILESTONES.forEach(([km, l], i) => { if (shown >= km && km > 0 && l === l.toUpperCase()) majorIdx = i; });
      if (majorIdx > lastMajor) { banner = { text: MILESTONES[majorIdx][1].split(" · ")[0], t: 0 }; lastMajor = majorIdx; }
      else if (majorIdx < lastMajor) lastMajor = majorIdx;

      // --- rocket + exhaust
      const ck = crash.current; ck.t += dt;
      const shake = reduce || ck.t > 1.1 ? 0 : (1 - ck.t / 1.1) * 4 * DPR; // fades out over ~1s
      const s = DPR * 1.15, rx = W / 2 + (reduce ? 0 : Math.sin(now / 1300) * 3 * DPR) + (Math.random() - 0.5) * 2 * shake, bob = reduce ? 0 : Math.sin(now / 300) * 1.5 * DPR;
      const ry = yOf(shown) - 22 * s + bob + (Math.random() - 0.5) * shake,
        tilt = reduce ? 0 : Math.sin(now / 900) * 0.025 + (Math.random() - 0.5) * 0.02 * clamp(thrust - 0.4) + Math.sin(now / 45) * 0.12 * (shake / (4 * DPR));
      if (!reduce) {
        const rate = (24 + thrust * 110) * (low ? 0.4 : 1) * (ck.t < 0.9 ? 0.15 + 0.85 * Math.random() * (ck.t / 0.9) : 1); // engine sputters
        if (ck.fresh) {
          ck.fresh = false;
          for (let i = 0; i < (low ? 14 : 30); i++) { const a = -Math.PI / 2 + (Math.random() - 0.5) * 2.4, sp = (40 + Math.random() * 120) * DPR;
            parts.push({ x: rx + (Math.random() - 0.5) * 14 * s, y: ry + (Math.random() * 20 - 4) * s, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, life: 0, max: 1.1 + Math.random() * 0.9, size: (4 + Math.random() * 5) * DPR, kind: "smoke" }); }
          for (let i = 0; i < 18; i++) { const a = Math.random() * Math.PI * 2, sp = (80 + Math.random() * 160) * DPR;
            parts.push({ x: rx, y: ry + 10 * s, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, life: 0, max: 0.4 + Math.random() * 0.4, size: (1.2 + Math.random() * 1.6) * DPR, kind: "spark", color: Math.random() < 0.5 ? "#ff6a4d" : "#ffb347" }); }
        }
        let n = rate * dt; while (n > 0) { if (Math.random() < n) parts.push({ x: rx + (Math.random() - 0.5) * 9 * s, y: ry + 22 * s, vx: (Math.random() - 0.5) * 40 * DPR, vy: (70 + 160 * thrust + Math.random() * 40) * DPR, life: 0, max: 0.8 + Math.random() * 0.8 * atmo + 0.3, size: (3 + Math.random() * 3) * DPR, kind: "fire" }); n -= 1; }
        if (b.fresh) {
          b.fresh = false; const col = TIER_COLOR[b.tier] || "#fff";
          rings.push({ r: 0, life: 1, color: col }); if (b.tier >= "t4") rings.push({ r: -30 * DPR, life: 1.15, color: "#ffffff" });
          const count = b.tier === "t5" ? 90 : b.tier === "t4" ? 65 : 40;
          for (let i = 0; i < count; i++) { const a = Math.random() * Math.PI * 2, sp = (120 + Math.random() * 260) * DPR; parts.push({ x: rx, y: ry, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, life: 0, max: 0.7 + Math.random() * 0.6, size: (1.5 + Math.random() * 2) * DPR, kind: "spark", color: col }); }
        }
      }
      for (let i = parts.length - 1; i >= 0; i--) {
        const p = parts[i]; p.life += dt; if (p.life > p.max) { parts.splice(i, 1); continue; }
        p.x += p.vx * dt; p.y += p.vy * dt + scroll * (p.kind === "fire" ? 0.3 : 1); // exhaust lags the world a little so the trail stays visible
        if (p.kind === "spark") { p.vx *= 1 - dt * 2.2; p.vy = p.vy * (1 - dt * 2.2) + 60 * DPR * dt; }
        else { p.vx *= 1 - dt * 0.8; p.vy *= 1 - dt * 1.2; p.size += dt * 18 * DPR * atmo + dt * 4 * DPR; }
      }
      const cap = low ? 120 : 320;
      if (parts.length > cap) parts.splice(0, parts.length - cap);
      // smoke (normal blend) then hot core / sparks (additive)
      for (const p of parts) if (p.kind === "smoke") {
        const t = p.life / p.max; ctx.globalAlpha = (1 - t) * 0.55; ctx.fillStyle = t < 0.15 ? "#5a4038" : "#2a2a33";
        ctx.beginPath(); ctx.arc(p.x, p.y, p.size, 0, 7); ctx.fill();
      }
      for (const p of parts) if (p.kind === "fire") {
        const t = p.life / p.max; if (t < 0.25) continue;
        ctx.globalAlpha = (1 - t) * 0.42 * (0.25 + atmo * 0.75); ctx.fillStyle = camL > 1 ? "#8d93b8" : "#d9dceb";
        ctx.beginPath(); ctx.arc(p.x, p.y, p.size, 0, 7); ctx.fill();
      }
      ctx.globalCompositeOperation = "lighter";
      for (const p of parts) {
        const t = p.life / p.max;
        if (p.kind === "spark") { ctx.globalAlpha = 1 - t; ctx.fillStyle = p.color!; ctx.beginPath(); ctx.arc(p.x, p.y, p.size * (1 - t * 0.5), 0, 7); ctx.fill(); continue; }
        if (t > 0.35 || p.kind === "smoke") continue; const k = t / 0.35;
        ctx.globalAlpha = (1 - k) * 0.85; ctx.fillStyle = k < 0.3 ? "#fff3c4" : k < 0.65 ? "#ffb347" : "#ff6a4d";
        ctx.beginPath(); ctx.arc(p.x, p.y, p.size * (0.6 + k * 0.6), 0, 7); ctx.fill();
      }
      ctx.globalCompositeOperation = "source-over"; ctx.globalAlpha = 1;

      // speed lines when climbing fast
      if (!reduce && vel > 0.12) {
        ctx.strokeStyle = `rgba(255,255,255,${clamp((vel - 0.12) * 0.6, 0, 0.35)})`; ctx.lineWidth = 1.2 * DPR;
        for (let i = 0; i < 14; i++) { const x = rx + (Math.random() - 0.5) * W * 0.7, y = Math.random() * H, l = (30 + Math.random() * 90) * DPR * clamp(vel); ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x, y + l); ctx.stroke(); }
      }

      drawRocket(rx, ry, s, tilt, thrust, now);

      // shockwave rings
      for (let i = rings.length - 1; i >= 0; i--) {
        const rg = rings[i]; rg.life -= dt * 1.1; rg.r += dt * 260 * DPR; if (rg.life <= 0) { rings.splice(i, 1); continue; }
        if (rg.r <= 0) continue;
        ctx.strokeStyle = rg.color; ctx.globalAlpha = clamp(rg.life); ctx.lineWidth = 3 * DPR * rg.life;
        ctx.beginPath(); ctx.arc(rx, ry, rg.r, 0, 7); ctx.stroke();
      }
      ctx.globalAlpha = 1;

      // milestone banner
      if (banner) {
        banner.t += dt; const t = banner.t, a = t < 0.3 ? t / 0.3 : t > 2.4 ? Math.max(0, 1 - (t - 2.4) / 0.6) : 1;
        if (a <= 0 && t > 2.4) banner = null;
        else {
          const sc = reduce ? 1 : 0.9 + 0.1 * clamp(t / 0.3);
          ctx.save(); ctx.translate(W / 2, cy + 135 * DPR); ctx.scale(sc, sc); ctx.globalAlpha = a; ctx.textAlign = "center";
          ctx.font = `600 ${10 * DPR}px ${font}`; ctx.fillStyle = "rgba(249,168,224,.9)"; ctx.fillText("MILESTONE REACHED", 0, -18 * DPR);
          ctx.font = `700 ${Math.min(28, W / DPR / 16) * DPR}px ${font}`; ctx.shadowColor = "rgba(244,114,208,.6)"; ctx.shadowBlur = 24 * DPR;
          ctx.fillStyle = "#ffffff"; ctx.fillText(banner.text, 0, 8 * DPR); ctx.restore();
        }
      }
      ctx.restore();

      // the HUD only needs ~10 updates a second; reporting every frame re-renders the whole page
      const rounded = Math.round(shown);
      if (rounded !== lastReport && now - lastReportAt > 100) { lastReport = rounded; lastReportAt = now; cb.current?.(shown); }
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    return () => { cancelAnimationFrame(raf); removeEventListener("resize", resize); };
  }, []);

  return <canvas ref={ref} className="sky" aria-hidden="true" />;
}
