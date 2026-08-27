// =============================================================================
// Route smoke — catch server-side render (SSR) crashes the API tests can't see.
// =============================================================================
// Logs in as each demo role through the REAL Auth.js credentials flow, then GETs
// every page route (dynamic segments filled with real ids resolved via the BFF)
// and flags any that 500 or render an error boundary. This is exactly the class
// of bug that slipped through twice: a page consuming an endpoint whose shape or
// emptiness it didn't expect throws only at render time, invisible to `jest`.
//
// Requires the web (:3000) AND api (:3001) running against a seeded DB.
//   Usage:  node scripts/route-smoke.mjs
//   Env:    WEB_URL (default http://localhost:3000)
//           SMOKE_PASSWORD (default password123)
//           SMOKE_ROLES="admin@demo.school,teacher@demo.school" (default: all)
// Exit code is non-zero if any route fails — wire it into CI after a build.
// =============================================================================

import { readdirSync } from "node:fs";
import { join } from "node:path";

/**
 * Where the stack is.
 *
 * // GOTCHA, and it is the same one `publicWebUrl()` records for the API's
 * twelve copies: `http://localhost:3000` is the NEXT DEV SERVER, and
 * `docker compose up` serves the stack through NGINX ON PORT 80. Defaulting to
 * 3000 meant the command the incident runbook tells you to run answered
 * "PROBE ERROR: fetch failed" against a perfectly healthy stack — on the
 * control that runbook calls "the most important test category". The API's
 * default was corrected and these four were not, because they live in another
 * package.
 *
 * Defaults to the compose stack, which is what an on-call reader has. Running
 * against `next dev` is a WEB_URL away, and the failure below says so.
 */
const WEB = process.env.WEB_URL ?? "http://localhost";
const PASSWORD = process.env.SMOKE_PASSWORD ?? "password123";
const DUMMY_UUID = "00000000-0000-4000-8000-000000000000";

// Every demo account (CLAUDE.md). A missing login is skipped, not failed.
const ALL_ROLES = [
  "owner@sms.platform", "admin@demo.school", "principal@demo.school", "board@demo.school",
  "teacher@demo.school", "student@demo.school", "parent@demo.school", "accountant@demo.school",
  "hr@demo.school", "hrmanager@demo.school", "headteacher@demo.school", "headadmin@demo.school",
  "warden@demo.school", "driver@demo.school", "headwarden@demo.school", "headdriver@demo.school",
  "librarian@demo.school", "junioradmin@demo.school",
];
const ROLES = (process.env.SMOKE_ROLES?.split(",").map((s) => s.trim()).filter(Boolean)) ?? ALL_ROLES;

// --- discover routes from the filesystem (stays current automatically) -------
function discoverRoutes(dir, prefix = "") {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const name = entry.name;
    // Route groups like (app) are stripped from the URL; private _folders skip.
    if (name.startsWith("_")) continue;
    const seg = name.startsWith("(") && name.endsWith(")") ? "" : `/${name}`;
    const child = join(dir, name);
    const childPrefix = prefix + seg;
    const files = readdirSync(child).map((f) => (typeof f === "string" ? f : f.name));
    if (files.includes("page.tsx") || files.includes("page.ts")) out.push(childPrefix || "/");
    out.push(...discoverRoutes(child, childPrefix));
  }
  return out;
}

// --- the OTHER rate limit, and how it lies to you ---------------------------
// GOTCHA: `TenantRateLimitService` caps the whole SCHOOL at
// TENANT_RATE_LIMIT_PER_MIN (default 1200) requests/minute, and every demo role
// belongs to the same school. 18 roles x 102 routes x several API calls each,
// with no think-time, saturates that budget partway through — after which
// `apiGet` correctly THROWS on a 429 (a 429 is not an answer about the data),
// the page renders its error boundary, and this smoke reports it as a FAILING
// ROUTE. The signature is a contiguous ALPHABETICAL TAIL of failures with
// digests that repeat across roles, and the proof is one line:
//
//   docker compose logs frontend | grep -c "API 429"
//
// It is not a page bug and it is not caused by whatever you just changed —
// though a change that gives a role MORE rows to render will make it start
// earlier, which reads exactly like a regression. Re-run the suspect role
// alone, and raise the ceiling for a full pass:
//
//   TENANT_RATE_LIMIT_PER_MIN=100000 docker compose up -d backend
//
// --- login pacing -----------------------------------------------------------
// The API rate-limits POST /auth/login (10/min per IP). Each web login triggers
// exactly one such call, so testing >9 roles would trip it and silently under-
// cover. A token bucket keeps us under the limit; a retry covers the boundary.
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const LOGIN_WINDOW_MS = 60_000;
const LOGIN_MAX_PER_WINDOW = 9;
const loginTimes = [];
async function pace() {
  const now = Date.now();
  while (loginTimes.length && now - loginTimes[0] > LOGIN_WINDOW_MS) loginTimes.shift();
  if (loginTimes.length >= LOGIN_MAX_PER_WINDOW) {
    const wait = LOGIN_WINDOW_MS - (now - loginTimes[0]) + 500;
    console.log(`  …pacing logins (rate limit): waiting ${Math.ceil(wait / 1000)}s`);
    await sleep(wait);
    return pace();
  }
  loginTimes.push(Date.now());
}

// --- cookie-jar HTTP with the Auth.js flow ----------------------------------
function makeClient() {
  const jar = new Map();
  const header = () => [...jar.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
  const store = (res) => {
    for (const c of res.headers.getSetCookie?.() ?? []) {
      const [kv] = c.split(";");
      const i = kv.indexOf("=");
      jar.set(kv.slice(0, i), kv.slice(i + 1));
    }
  };
  return {
    async login(email) {
      // Two attempts: the second waits out the full rate-limit window in case
      // the bucket estimate drifted (other clients sharing the IP, clock skew).
      for (let attempt = 0; attempt < 2; attempt++) {
        await pace();
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
        if ([...jar.keys()].some((k) => k.includes("session-token"))) return true;
        if (attempt === 0) { console.log(`  …retrying login for ${email} after the rate window`); await sleep(LOGIN_WINDOW_MS + 500); }
      }
      return false;
    },
    async get(path) {
      return fetch(`${WEB}${path}`, { headers: { cookie: header() }, redirect: "manual" });
    },
    /** Bytes of the Auth.js session cookie(s) — the size guardrail reads this. */
    sessionCookieBytes() {
      let n = 0;
      for (const [k, v] of jar.entries()) if (k.includes("session-token")) n += k.length + v.length + 1;
      return n;
    },
    // Read JSON via the BFF proxy (same auth path the app uses).
    async api(path) {
      const r = await this.get(`/api/sms${path}`);
      if (r.status !== 200) return null;
      const t = await r.text();
      return t ? JSON.parse(t) : null;
    },
  };
}

// --- resolve one real id per dynamic route (best effort, via an admin) -------
async function resolveIds(admin) {
  const first = (v) => (Array.isArray(v) ? v[0] : Array.isArray(v?.tenants) ? v.tenants[0] : null);
  const students = await admin.api("/students");
  const classes = await admin.api("/classes/mine");
  const assessments = await admin.api("/assessments");
  const invoices = await admin.api("/invoices");
  const users = await admin.api("/users");
  return {
    studentId: first(students)?.id ?? DUMMY_UUID,
    classId: first(classes)?.id ?? DUMMY_UUID,
    assessmentId: first(assessments)?.id ?? DUMMY_UUID,
    invoiceId: first(invoices)?.id ?? DUMMY_UUID,
    userId: first(users)?.id ?? DUMMY_UUID,
  };
}

// Map a discovered route template to a concrete URL using resolved ids.
function fill(route, ids) {
  return route
    .replace("/students/[id]", `/students/${ids.studentId}`)
    .replace("/assessments/[assessmentId]", `/assessments/${ids.assessmentId}`)
    .replace(/\/classes\/\[id\]/, `/classes/${ids.classId}`)
    .replace("/content/[id]", `/content/${DUMMY_UUID}`)
    .replace("/fees/[id]", `/fees/${ids.invoiceId}`)
    .replace("/hr/staff/[userId]", `/hr/staff/${ids.userId}`)
    // Game detail pages: a syntactically valid but non-existent id — a healthy
    // page 404s / shows a "not found" state; a broken one 500s.
    .replace(/\/games\/(duel|league|race|ring|ultimate)\/\[id\]/, `/games/$1/${DUMMY_UUID}`);
}

/** Pause before re-requesting a failed route. Long enough for the per-tenant
 *  rate-limit window to give back budget, short enough to stay usable. */
const RETRY_PAUSE_MS = Number(process.env.SMOKE_RETRY_PAUSE_MS ?? 8000);

const ERROR_RE = /Application error|server-side exception|is not a function|Cannot read propert|TypeError|__NEXT_ERROR/i;

// A page that THROWS during SSR is served as a 200 carrying the error boundary,
// and that boundary is a CLIENT component — so none of the strings above appear
// in the HTML and the shell looks like an ordinary small page. This smoke
// reported "all 102 routes ok" for every role while four roles were getting an
// error screen on /workflows, because it could not see this at all.
//
// What a throw does leave is a serialized digest in the flight stream. Next uses
// the same channel for ordinary CONTROL FLOW, so the digest VALUE is the signal,
// not its presence:
//   NEXT_NOT_FOUND               notFound()  — a missing record, correct
//   NEXT_REDIRECT;...            redirect()  — a permission gate firing, correct
//   NEXT_HTTP_ERROR_FALLBACK;404 the same, newer form
//   <numeric>                    an UNCAUGHT error — the error boundary
// Matching the presence of a digest (or React's $RX retry shim, which also fires
// on recovered suspense) reported 917 failures, nearly all of them healthy pages
// 404ing or redirecting exactly as designed.
const DIGEST_RE = /E\{\\?"digest\\?":\\?"([^"\\]+)/g;
const CONTROL_FLOW = /^(NEXT_NOT_FOUND|NEXT_REDIRECT|NEXT_HTTP_ERROR_FALLBACK)/;

/** Digests that mean a real throw, ignoring Next's control-flow sentinels. */
function errorDigests(html) {
  return [...html.matchAll(DIGEST_RE)].map((m) => m[1]).filter((d) => !CONTROL_FLOW.test(d));
}

function classify(status, html) {
  if (status === 500) return "FAIL";
  if (status === 200 && ERROR_RE.test(html)) return "FAIL";
  if (status === 200 && errorDigests(html).length) return "FAIL";
  return "ok"; // 200-clean, 3xx redirect (perm/nav), 401/403/404 are all fine
}

async function main() {
  const appDir = join(process.cwd(), "app", "(app)");
  const routes = [...new Set(discoverRoutes(appDir))].sort();
  console.log(`Discovered ${routes.length} routes; testing ${ROLES.length} role(s) against ${WEB}\n`);

  // Resolve ids once as an admin (falls back to dummy uuids if unavailable).
  const admin = makeClient();
  let ids = { studentId: DUMMY_UUID, classId: DUMMY_UUID, assessmentId: DUMMY_UUID, invoiceId: DUMMY_UUID, userId: DUMMY_UUID };
  if (await admin.login("admin@demo.school")) ids = await resolveIds(admin);
  else if (await admin.login("owner@sms.platform")) ids = await resolveIds(admin);
  console.log("Resolved ids:", ids, "\n");

  // GUARDRAIL: the session cookie must stay well under the ~4 KB browser cap and
  // nginx's default header buffer. It once hit 3.7 KB (the full permissions
  // array rode in it) and 502'd every role-heavy login — permissions are now
  // derived from roles server-side, so a breach here means someone re-inflated
  // the cookie. Budget is deliberately tight to catch creep early.
  const COOKIE_BUDGET_BYTES = 3072;
  let maxCookie = { email: "-", bytes: 0 };

  const failures = [];
  let skipped = 0;
  let unchecked = 0;
  for (const email of ROLES) {
    const client = makeClient();
    if (!(await client.login(email))) { console.log(`- ${email}: login failed (skipped)`); skipped++; continue; }
    const cookieBytes = client.sessionCookieBytes();
    if (cookieBytes > maxCookie.bytes) maxCookie = { email, bytes: cookieBytes };
    const bad = [];
    // Routes we could not judge because the API was rate-limiting THIS RUN.
    const rateLimited = new Set();
    if (cookieBytes > COOKIE_BUDGET_BYTES) {
      bad.push(`session cookie is ${cookieBytes} bytes (> ${COOKIE_BUDGET_BYTES} budget) — the cookie is re-inflating; see route-smoke guardrail note`);
    }
    for (const route of routes) {
      const url = fill(route, ids);
      // RETRY ONCE ON FAILURE — this is what separates a defect from a 429.
      //
      // The API rate-limits per TENANT (1200/min, shared by the whole school).
      // This tool asks for 104 routes as fast as it can, several API calls each,
      // all as the demo school — so it exhausts that budget on its own and the
      // tail of every run comes back rate limited. Those arrive as SSR throws
      // with a digest, which looked EXACTLY like a broken page: three separate
      // investigations here ended in "all of them were 429s". A run that cannot
      // tell a defect from its own load is not measuring the app.
      //
      // A real SSR throw is deterministic and repeats; a rate-limit is
      // transient and clears. So a failure is re-requested once after a pause,
      // and only a SECOND failure is reported. Costs one pause per failure and
      // nothing at all on a clean run.
      let res, html, verdict;
      for (let attempt = 0; attempt < 2; attempt++) {
        if (attempt) await new Promise((r) => setTimeout(r, RETRY_PAUSE_MS));
        try { res = await client.get(url); } catch (e) { verdict = `fetch error: ${e.message}`; continue; }
        html = res.status === 200 ? await res.text() : "";
        verdict = classify(res.status, html) === "FAIL" ? null : "ok";
        if (verdict === "ok") break;
        verdict = null;
      }
      if (verdict !== "ok") {
        // STILL FAILING — so ASK the API whether we are the problem.
        //
        // A rate-limited page throws during SSR and arrives as a 200 carrying a
        // digest, exactly like a broken one. The digest is a hash, so the tool
        // cannot read the reason out of the HTML. But it CAN put one cheap
        // question to the API directly: are you rate-limiting me right now? If
        // so this run has exhausted the school's per-tenant budget and the
        // "failure" is our own load, which must be reported as such rather than
        // counted as a defect — a tool that cries wolf gets ignored, and then
        // the real SSR throw goes with it.
        const probe = await client.get("/api/sms/notifications").catch(() => null);
        if (probe?.status === 429) {
          rateLimited.add(url);
          continue;
        }
        // Pull the Next digest if present for quick server-log correlation.
        const dig = html ? (errorDigests(html)[0] ?? html.match(/Digest:\s*(\d+)/)?.[1]) : undefined;
        bad.push(`${url} -> ${res?.status ?? "-"}${dig ? ` (digest ${dig})` : ""} [failed twice]`);
      }
    }
    if (bad.length) { failures.push({ email, bad }); console.log(`✗ ${email}: ${bad.length} failing`); bad.forEach((b) => console.log(`    ${b}`)); }
    else console.log(`✓ ${email}: all ${routes.length - rateLimited.size} routes ok`);
    if (rateLimited.size) {
      // Said out loud, never silently: these were NOT checked, and a run that
      // hides that is claiming coverage it does not have.
      console.log(`    (${rateLimited.size} not checked — the API rate-limited this run: ${[...rateLimited].join(", ")})`);
      unchecked += rateLimited.size;
    }
  }

  console.log("");
  console.log(`Largest session cookie: ${maxCookie.bytes} bytes (${maxCookie.email}); budget ${COOKIE_BUDGET_BYTES}.`);
  if (failures.length) {
    console.log(`ROUTE SMOKE FAILED — ${failures.reduce((n, f) => n + f.bad.length, 0)} bad render(s) across ${failures.length} role(s).`);
    process.exit(1);
  }
  console.log(
    `ROUTE SMOKE PASSED — every route rendered for every role${skipped ? ` (${skipped} role login(s) skipped)` : ""}` +
      `${unchecked ? `, ${unchecked} route(s) NOT CHECKED because the API rate-limited this run` : ""}.`,
  );
}

main().catch((e) => { console.error("SMOKE ERROR:", e.stack ?? e.message); process.exit(1); });
