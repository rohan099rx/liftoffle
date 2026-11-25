# Liftoffle · name the thing nobody else will

Brand assets (logos, icons, banners) live in `brand/`; a zipped kit is `liftoffle-brand-kit.zip`.

A rare-answer word game. Seven prompts; the fewer players who give your answer, the higher your rocket flies.
Prompts are written fresh by Groq, answers are judged by Groq, and rarity comes from how people in general answer.

## Features

- **Daily Launch**: 7 AI-written prompts, the same for everyone, new every day at 00:00 UTC, with a daily leaderboard and streaks.
- **Endless mode**: a brand-new AI-written set on every run, in 11 categories (space, food, music, geography, movies & TV…).
- **AI judge**: accepts typos, plurals and alternate names ("DRC" → Congo); rejects made-up, vague or joke answers.
- **General rarity**: for each prompt the AI builds one cached Family-Feud-style survey (what % of 1,000 typical people would give each answer). Rarity comes from that survey, not from who plays here; answers missing from the survey score as rarer than everything on it. Common survey answers are judged instantly with no AI call.
- **Hints** (cost half the round's points), **skip**, and **"what did everyone else say?"** after each answer.
- **Player profile in the database**: every answer attempt (accepted, refused or skipped; solo and party), every finished run, totals, tier counts, favourite topic, rarest answer ever, badges and name history are saved per player in Redis (`profile:`, `answers:`, `runs:` keys; `lib/profile.ts`). Stats from the old browser-only storage are imported once. No IP or device data is stored.
- **Progression**: lifetime points are XP; levels with rank titles (Cadet → Star Legend), **This week** and **All-time** leaderboards (`lb:wk:{monday}`, `lb:all`; a daily run only counts the first time each day), a **daily bonus** with a check-in streak (bigger on days 3 and 7), **boosts** (a free hint that keeps full points; from the bonus and level-ups, max 5) and server-checked milestone badges. Rules live in `lib/progress.ts`.
- **The climb**: the rocket flies past ~20 real things at their real altitudes (birds, hot-air balloons, an airliner, a weather balloon, the aurora, Hubble, GPS satellites, the Moon, Webb, a comet, Mars, the asteroid belt, Jupiter). Each first sighting goes into your **Sky Log**; the results screen replays the whole flight.
- **Rebuilding the overall boards**: `node scripts/backfill-boards.mjs` (dry run) / `--apply` recomputes This week / All-time and XP from the daily boards and run history still in Redis. It never lowers a score, so it's safe to re-run.
- **Party extras**: a **Sudden Death** final (top two, one extra prompt, 10 seconds, one try, ×2 rarity points, simultaneous flip reveal) and **Room DNA** (per-player memory of answers given in front of friends, 90 days in `dna:{uid}`; repeating yourself loses the only-you bonus and costs 10, and the podium shows each player's traits). Both are host toggles in the lobby, on by default.
- **Results**: a crowd chart after every answer (labelled as an AI estimate), a shareable flight-card image, and an AI "pilot profile" at the end of a run.
- **Curiosity**: after each answer, a cached AI "Did you know?" fact about it, plus what most people said, the survey's deepest cut and where your answer ranked. Quips are picked fresh per answer from large, answer-aware pools, and on-screen lines don't repeat back to back.
- Leaderboard nicknames, a stats page, a copyable emoji result, sound effects, resume after refresh, and the countdown to the next launch.

## Run it locally

```bash
npm install
cp .env.example .env.local      # add your keys (see below)
npm run dev                     # http://localhost:3000
```

With no `GROQ_API_KEY` (or `GROQ_MOCK=1`) it runs in **test mode** on a built-in pool of 10 prompts, so you can play it offline.

## Deploy on Vercel

1. Push this folder to a Git repo and import it in Vercel.
2. Add a free **Upstash Redis** database, and keep it in the same region as your Vercel functions (`vercel.json` → `regions`; this project uses `bom1` = Mumbai). Every request makes several Redis calls, so a cross-world hop makes the game feel laggy (Vercel Marketplace → Upstash). It sets `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN`.
   This is required in production. Without it, runs, counts and the leaderboard live in one server's memory and get lost between requests.
3. In Project → Settings → Environment Variables, add:
   - `GROQ_API_KEY`: your key from console.groq.com. **Never** give it a `NEXT_PUBLIC_` prefix.
   - `RECEIPT_SECRET`: the output of `openssl rand -base64 48`.
   - optional: `GROQ_MODEL` (default `openai/gpt-oss-120b`).
4. Deploy. Edit `public/.well-known/security.txt` with your real contact email.

## Security design (lessons from the Krillion review)

| Risk | What this app does |
|---|---|
| Score tampering | Every answer returns an HMAC-signed receipt; `/api/complete` recomputes the score from receipts and ignores any score the client sends. |
| Re-rolling for a rarer tier | Each round can be answered once per run (server lock). |
| Using someone else's run or receipts | Runs and receipts are bound to the player ID in a signed, **HttpOnly** cookie that page scripts can't read. |
| Leaked API key | Groq is only called from server routes; the key is never sent to the browser. |
| Prompt injection via answers | Answers are cleaned (length cap, control/zero-width characters stripped), passed to the model as JSON data, judged with temperature 0 and a strict JSON schema. The judge is told to treat answers as untrusted text. |
| Runaway AI costs | Endless runs are rate-limited per player and per IP; verdicts and hints are cached so repeated answers cost nothing. |
| Third-party script risk | Strict CSP (`default-src 'self'`, `frame-ancestors 'none'`), plus nosniff, Referrer-Policy, Permissions-Policy, HSTS and COOP headers. No ads or trackers. |
| Cross-site requests | State-changing routes check `Origin`; cookies are `SameSite=Lax`. |

If you add ads or analytics later, add their domains to the CSP in `next.config.ts` rather than loosening it, and keep secrets out of `localStorage`.

## Project layout

```
app/page.tsx         game UI (menu, play, results, leaderboard, stats)
app/Sky.tsx          canvas sky + rocket (log altitude scale)
app/api/*            today, run, submit, hint, reveal, curio, complete, leaderboard, profile
lib/game.ts          prompt generation, judging, rarity, hints
lib/groq.ts          server-only Groq client (strict JSON schema output)
lib/security.ts      signed receipts/cookies, rate limits, origin checks
lib/profile.ts       per-player history and totals (answers, runs, badges, names)
lib/store.ts         Upstash Redis REST, with an in-memory fallback
lib/seed.ts          offline prompt pool (test mode + fallback if Groq is down)
```
