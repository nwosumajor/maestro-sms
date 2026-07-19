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

const WEB = process.env.WEB_URL ?? "http://localhost:3000";
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

const ERROR_RE = /Application error|server-side exception|is not a function|Cannot read propert|TypeError|__NEXT_ERROR/i;

function classify(status, html) {
  if (status === 500) return "FAIL";
  if (status === 200 && ERROR_RE.test(html)) return "FAIL";
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
  for (const email of ROLES) {
    const client = makeClient();
    if (!(await client.login(email))) { console.log(`- ${email}: login failed (skipped)`); skipped++; continue; }
    const cookieBytes = client.sessionCookieBytes();
    if (cookieBytes > maxCookie.bytes) maxCookie = { email, bytes: cookieBytes };
    const bad = [];
    if (cookieBytes > COOKIE_BUDGET_BYTES) {
      bad.push(`session cookie is ${cookieBytes} bytes (> ${COOKIE_BUDGET_BYTES} budget) — the cookie is re-inflating; see route-smoke guardrail note`);
    }
    for (const route of routes) {
      const url = fill(route, ids);
      let res;
      try { res = await client.get(url); } catch (e) { bad.push(`${url} (fetch error: ${e.message})`); continue; }
      const html = res.status === 200 ? await res.text() : "";
      if (classify(res.status, html) === "FAIL") {
        // Pull the Next digest if present for quick server-log correlation.
        const dig = html.match(/Digest:\s*(\d+)/)?.[1];
        bad.push(`${url} -> ${res.status}${dig ? ` (digest ${dig})` : ""}`);
      }
    }
    if (bad.length) { failures.push({ email, bad }); console.log(`✗ ${email}: ${bad.length} failing`); bad.forEach((b) => console.log(`    ${b}`)); }
    else console.log(`✓ ${email}: all ${routes.length} routes ok`);
  }

  console.log("");
  console.log(`Largest session cookie: ${maxCookie.bytes} bytes (${maxCookie.email}); budget ${COOKIE_BUDGET_BYTES}.`);
  if (failures.length) {
    console.log(`ROUTE SMOKE FAILED — ${failures.reduce((n, f) => n + f.bad.length, 0)} bad render(s) across ${failures.length} role(s).`);
    process.exit(1);
  }
  console.log(`ROUTE SMOKE PASSED — every route rendered for every role${skipped ? ` (${skipped} role login(s) skipped)` : ""}.`);
}

main().catch((e) => { console.error("SMOKE ERROR:", e.stack ?? e.message); process.exit(1); });
