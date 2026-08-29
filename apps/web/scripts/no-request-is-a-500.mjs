// =============================================================================
// No ordinary request, and no hostile one, is a 500
// =============================================================================
// A 5xx is the one status that is unambiguously OUR fault. It tells the caller
// nothing they can act on — the fix for `?page=abc` is "1", and the message says
// "Internal server error" — and it SPENDS AN ALERT, because a 5xx is what pages
// somebody. A mistyped URL in a bookmark bar becomes indistinguishable from the
// database being down.
//
// This repo has been bitten by that class twice, both found by accident:
//   * `?page=abc` reached Prisma as `skip: NaN` on seven paged lists;
//   * a raw `FOR UPDATE` lock cast a malformed id before MalformedIdFilter could
//     see it, so the bursar's record-payment desk answered 500 where every other
//     route answered 404.
// Both are fixed and gated at the unit level. Neither gate can see a route added
// later that reaches the database another way, which is what this probe is for.
//
// THREE SWEEPS, and the third is the one the unit gates cannot replace:
//   1. every parameterless GET, as four different roles — an ordinary request;
//   2. the same routes with hostile query strings — the `page=abc` class;
//   3. every single-parameter GET with a malformed id — the MalformedIdFilter
//      class, including a path-traversal and an SQL fragment.
//
// WHAT IS NOT A FINDING: 400, 403 and 404 are all answers. A 400 naming the
// allowed values is the CORRECT response to `status=NOT_A_STATUS` and is what
// several of this repo's fixes deliberately produce. Only 5xx counts.
//
// Needs a running stack and is not in CI, like the other four probes. It signs
// in as several accounts, and `POST /auth/login` is rate-limited 10/min per IP,
// so running two probes back to back can fail on the LIMITER rather than on the
// stack — the summary says so rather than reporting a clean run.
//
// Usage:
//   WEB_URL=http://localhost pnpm --filter @sms/web probe:no-500
// =============================================================================
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const WEB = process.env.WEB_URL ?? "http://localhost";
const PASSWORD = process.env.SMOKE_PASSWORD ?? "password123";
const API_SRC = join(process.cwd(), "..", "api", "src");

const walk = (dir) =>
  readdirSync(dir).flatMap((e) => {
    const p = join(dir, e);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });

/**
 * Every GET the API declares, split by how many path parameters it has.
 *
 * DERIVED, never listed: a hand-kept route table is the thing this repo has
 * watched rot in four separate places. The nearest `@Controller` above a route
 * wins, because three files declare two.
 */
function getRoutes() {
  const none = [];
  const oneParam = [];
  for (const f of walk(API_SRC).filter((p) => p.endsWith(".controller.ts"))) {
    const src = readFileSync(f, "utf8");
    const prefixes = [...src.matchAll(/@Controller\(\s*"([^"]*)"\s*\)/g)].map((m) => [m.index, m[1]]);
    for (const m of src.matchAll(/@Get\(\s*(?:"([^"]*)")?\s*\)/g)) {
      let pre = "";
      for (const [pos, p] of prefixes) if (pos < m.index) pre = p;
      const full = [pre, m[1] ?? ""].filter(Boolean).join("/");
      if (!full || /\.(pdf|csv)$/.test(full)) continue; // binary streams answer differently
      const params = (full.match(/:/g) ?? []).length;
      if (params === 0) none.push(full);
      else if (params === 1) oneParam.push(full);
    }
  }
  return { none: [...new Set(none)], oneParam: [...new Set(oneParam)] };
}

const HOSTILE = [
  "page=abc", "page=0", "page=-1", "page=1e999", "limit=999999",
  "from=abc", "to=abc", "from=2026-13-45", "status=NOT_A_STATUS",
  `q=${"x".repeat(500)}`, "year=abc", "days=abc",
];
/** A malformed id, a traversal, a nil uuid and an SQL fragment. */
const BAD_IDS = ["not-a-uuid", "../etc/passwd", "00000000-0000-0000-0000-000000000000", "1 OR 1=1"];

function session() {
  const jar = new Map();
  const header = () => [...jar].map(([k, v]) => `${k}=${v}`).join("; ");
  const store = (res) => {
    for (const c of res.headers.getSetCookie?.() ?? []) {
      const [kv] = c.split(";");
      const i = kv.indexOf("=");
      jar.set(kv.slice(0, i), kv.slice(i + 1));
    }
  };
  return {
    async login(email) {
      jar.clear();
      let r = await fetch(`${WEB}/api/auth/csrf`, { headers: { cookie: header() } });
      store(r);
      const { csrfToken } = await r.json();
      r = await fetch(`${WEB}/api/auth/callback/credentials`, {
        method: "POST", redirect: "manual",
        headers: { "content-type": "application/x-www-form-urlencoded", cookie: header() },
        body: new URLSearchParams({ csrfToken, email, password: PASSWORD, redirect: "false", json: "true" }),
      });
      store(r);
    },
    async get(path) {
      const res = await fetch(`${WEB}/api/sms/${path}`, { headers: { cookie: header() }, redirect: "manual" });
      const body = res.status >= 500 ? (await res.text()).slice(0, 140) : "";
      return { status: res.status, body };
    },
  };
}

const ROLES = ["principal", "teacher", "parent", "student"];

async function main() {
  const { none, oneParam } = getRoutes();
  // A walk that finds nothing passes every assertion below, so say the size out
  // loud and refuse a run that plainly did not read the controllers.
  console.log(`${none.length} parameterless GET routes, ${oneParam.length} single-parameter GET routes`);
  if (none.length < 100 || oneParam.length < 50) {
    console.error("PROBE ERROR: too few routes extracted — the controllers were not read. Run from apps/web.");
    process.exit(4);
  }

  const s = session();
  const findings = [];
  let probes = 0;
  let signedIn = 0;

  for (const role of ROLES) {
    await s.login(`${role}@demo.school`);
    // PROVE THE SESSION TOOK. A rate-limited or missing account answers 401 to
    // everything, and 401 is not 5xx — so the sweep would run green having
    // tested nothing. The isolation and family probes were both wrong this way.
    const probe = await s.get("notifications?page=1");
    if (probe.status === 401) {
      console.error(`  ${role}: not signed in (401) — rate limiter, or the account is missing`);
      continue;
    }
    signedIn += 1;
    for (const p of none) {
      probes += 1;
      const r = await s.get(p);
      if (r.status >= 500) findings.push(`${role} GET /${p} -> ${r.status} ${r.body}`);
    }
  }

  if (signedIn === 0) {
    console.error("PROBE ERROR: no role signed in — is the stack up and seeded?");
    process.exit(3);
  }

  // The hostile sweeps need one session only: a 500 from a bad parameter is not
  // a function of who is asking.
  await s.login("principal@demo.school");
  for (const p of none) {
    for (const qs of HOSTILE) {
      probes += 1;
      const r = await s.get(`${p}?${qs}`);
      if (r.status >= 500) findings.push(`GET /${p}?${qs} -> ${r.status} ${r.body}`);
    }
  }
  for (const p of oneParam) {
    for (const id of BAD_IDS) {
      probes += 1;
      const r = await s.get(p.replace(/:[A-Za-z]+/, encodeURIComponent(id)));
      if (r.status >= 500) findings.push(`GET /${p} [id=${id}] -> ${r.status} ${r.body}`);
    }
  }

  console.log(`probed ${probes} requests across ${signedIn} of ${ROLES.length} role(s)`);
  if (findings.length) {
    console.error(`\n${findings.length} request(s) answered 5xx:\n  ${findings.join("\n  ")}`);
    process.exit(1);
  }
  if (signedIn < ROLES.length) {
    console.error(`\nINCOMPLETE — ${ROLES.length - signedIn} role(s) never signed in, so their sweep did not run.`);
    process.exit(3);
  }
  console.log("NO 500s — every request answered with something the caller can act on.");
}

main().catch((e) => {
  console.error(`PROBE ERROR: ${e.message}\n  WEB_URL is ${WEB} (compose serves nginx on :80; next dev is :3000)`);
  process.exit(2);
});
