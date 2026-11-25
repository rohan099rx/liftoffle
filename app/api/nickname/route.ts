import { cleanNick, nickKey, nickProblem, saveNick } from "@/lib/nick";
import { body, json, limited, playerFrom, sameOrigin } from "@/lib/security";
import * as kv from "@/lib/store";
import { logName } from "@/lib/profile";

export const dynamic = "force-dynamic";

/** Your current board name (null if you never set one). */
export async function GET(req: Request) {
  const p = playerFrom(req);
  return json({ name: await kv.get<string>(nickKey(p.id)) }, { cookie: p.setCookie });
}

/** Set or change your name. It shows on every board you're on straight away, including today's. */
export async function POST(req: Request) {
  if (!sameOrigin(req)) return json({ error: "bad-origin" }, { status: 403 });
  const p = playerFrom(req), c = p.setCookie;
  if (await limited("nick", p.id, 20, 600)) return json({ error: "Too many name changes. Try again in a few minutes." }, { status: 429, cookie: c });
  const name = cleanNick((await body<{ nickname?: string }>(req))?.nickname);
  const problem = nickProblem(name);
  if (problem) return json({ error: problem }, { status: 400, cookie: c });
  await saveNick(p.id, name);
  await logName(p.id, name);
  return json({ ok: true, name }, { cookie: c });
}
