// =============================================================================
// Family-scope probe — what a parent actually receives, end to end
// =============================================================================
// The sibling of isolation-probe.mjs, on the axis that probe explicitly sets
// aside. That one proves school A cannot reach school B and says, correctly,
// that "listing endpoints are the easy case — RLS empties them and nothing
// leaks".
//
// That is true ACROSS tenants and false inside one. Every family in a school
// shares a school_id, so RLS returns all 900 pupils to every one of them and is
// working exactly as designed. The only thing standing between a parent and
// another family's child is application code: visibleStudentIds, parentChild
// joins, per-module scope sets. Each of those is unit-tested against a stub. The
// composition — real session, real BFF, real guard, real service, real database
// — was not tested at all on this axis.
//
// So this asks the plainest possible question. Sign in as an ordinary parent,
// call the endpoints the family-facing pages call, and look in every response
// for the id OR THE NAME of a pupil who is not their child.
//
// NAMES MATTER AS MUCH AS IDS, and the first version of this checked only ids.
// A roster that renders "Ada Okoro" without an id beside it is the same
// disclosure and would have passed. Names are matched longest-first, so
// "Volume Pupil 1" cannot mask a hit on "Volume Pupil 174".
//
// A NON-200 IS NOT A FAILURE. A parent hitting a staff endpoint should get 403,
// and an out-of-scope record should get 404 rather than 403 — both are the
// system working. Only a 200 carrying somebody else's child is a finding.
//
// PART TWO asks the id-addressed question, which part one deliberately does not:
// what happens when a family names another family's record directly. Six
// separate modules state the same rule in a comment — "404, not 403 — never
// reveal another family's invoice / document / student" — because a 403
// confirms the record exists.
//
// EVERY PROBE IS PAIRED WITH A GHOST — the same request with an id that exists
// nowhere. Only a DIFFERENCE between the two discloses anything. Without that
// control this probe reported two leaks that were nothing of the kind: a pupil
// asking for contacts or a medical record gets 403 from the permission guard,
// which holds no opinion about whether the record exists, and answers a
// non-existent id identically. A status code on its own cannot tell those
// apart.
//
// Usage (needs the stack up and the demo fixtures seeded):
//   WEB_URL=http://localhost pnpm --filter @sms/web probe:family
// =============================================================================

import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

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
/** Ordinary family accounts — the position a real parent and pupil are in. */
const AS = (process.env.PROBE_FAMILY ?? "parent@demo.school,student@demo.school").split(",");

/**
 * The family-facing surface: what the parent and pupil pages actually call.
 *
 * Parameterless on purpose. An id-addressed probe is the other script's job and
 * answers a different question ("can I reach a record I already know of");, this
 * one asks what the system VOLUNTEERS when simply asked for the ordinary page.
 */
/**
 * THE HAND-WRITTEN LIST IS THE FLOOR, NOT THE COVERAGE.
 *
 * These carry query strings a reader cannot invent, so they stay written out.
 * Everything else is DERIVED below from the API's own controllers, because a
 * hand-maintained list of "what a family can reach" is a list that falls behind:
 * it had thirteen entries while a pupil's session could reach 133 GET routes.
 * The same reasoning as the RLS coverage meta-test — the set under test has to
 * be computed from the code, or a new endpoint joins the surface untested and
 * the probe still says PASS.
 */
const PATHS = [
  "/students",
  "/invoices",
  "/documents",
  "/notifications",
  "/messages/contacts",
  "/messages/threads",
  "/attendance/by-class",
  "/attendance/registers",
  "/polls",
  "/privacy/erasure",
  "/search?q=a",
  // Deliberately searching for the fixture prefix: a search that leaks is the
  // most likely single endpoint to do so, because its whole job is to find
  // things by name.
  "/search?q=Pupil",
];

// --- what this account can actually reach ------------------------------------

/**
 * Every parameter-less GET the API serves whose permission this account holds.
 *
 * Read from the controllers rather than from a list, so an endpoint added
 * tomorrow and gated on `grade.read` is probed tonight without anyone
 * remembering to add it.
 *
 * PARAMETERISED ROUTES ARE NOT COVERED HERE and are counted out loud. They need
 * an id this probe cannot invent; part two asks the id-addressed question for
 * the family-facing ones deliberately. A probe that quietly skipped them would
 * be claiming a coverage it does not have.
 */
function reachableGets(permissions) {
  const held = new Set(permissions);
  const apiSrc = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "api", "src");

  // Permission CONSTANTS -> their string values, from the single source of truth.
  const values = new Map();
  const typesSrc = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "packages", "types", "src", "permissions");
  for (const f of walk(typesSrc, (n) => n.endsWith(".ts"))) {
    for (const m of readFileSync(f, "utf8").matchAll(/(\w+):\s*"([\w.]+)"/g)) values.set(m[1], m[2]);
  }

  const out = [];
  const skipped = [];
  for (const file of walk(apiSrc, (n) => n.endsWith(".controller.ts"))) {
    const src = readFileSync(file, "utf8");
    const prefix = (/@Controller\(\s*["'`]([^"'`]*)["'`]\s*\)/.exec(src) ?? [null, ""])[1];
    for (const m of src.matchAll(/@Get\(\s*(?:["'`]([^"'`]*)["'`])?\s*\)([\s\S]{0,400}?)\)\s*(?::|\{)/g)) {
      const sub = m[1] ?? "";
      const body = m[2];
      if (/@(Post|Put|Patch|Delete)\(/.test(body)) continue;
      const keys = new Set();
      for (const g of body.matchAll(/@RequirePermission\(([^)]*)\)/g)) {
        for (const c of g[1].matchAll(/([A-Z_]+_PERMISSIONS)\.(\w+)/g)) {
          if (values.has(c[2])) keys.add(values.get(c[2]));
        }
        for (const lit of g[1].matchAll(/"([\w.]+)"/g)) keys.add(lit[1]);
      }
      if (keys.size === 0 || ![...keys].some((k) => held.has(k))) continue;
      const path = "/" + [prefix, sub].filter(Boolean).join("/");
      (path.includes(":") ? skipped : out).push(path);
    }
  }
  return { paths: [...new Set(out)].sort(), skipped: [...new Set(skipped)] };
}

function walk(dir, pred, acc = []) {
  for (const e of readdirSync(dir)) {
    if (e === "node_modules" || e === "dist") continue;
    const f = join(dir, e);
    if (statSync(f).isDirectory()) walk(f, pred, acc);
    else if (pred(e)) acc.push(f);
  }
  return acc;
}

function client() {
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
        method: "POST",
        redirect: "manual",
        headers: { "content-type": "application/x-www-form-urlencoded", cookie: header() },
        body: new URLSearchParams({ csrfToken, email, password: PASSWORD, redirect: "false", json: "true" }),
      });
      store(r);
      return [...jar.keys()].some((k) => k.includes("session-token"));
    },
    async get(path) {
      const res = await fetch(`${WEB}/api/sms${path}`, { headers: { cookie: header() }, redirect: "manual" });
      return { status: res.status, text: await res.text() };
    },
    /** The signed-in session, for the permissions this account actually holds. */
    async permissions() {
      const res = await fetch(`${WEB}/api/auth/session`, { headers: { cookie: header() } });
      if (!res.ok) return [];
      try {
        return (await res.json())?.user?.permissions ?? [];
      } catch {
        return [];
      }
    },
  };
}

/**
 * A 401 means the probe never asked the question.
 *
 * 403 and 404 are real answers from an authenticated caller and are exactly
 * what this probe is looking for — the existing comparison is right to treat a
 * matching 403 as "the permission guard, disclosing nothing". 401 is different:
 * there is no session at all. A degraded run reported
 * "PASS — no response carried another family's child" with every single check
 * reading `(401, same as a non-existent id)`.
 */
function abortIfUnauthenticated(status, where) {
  if (status !== 401) return;
  console.error(
    `\nPROBE ABORTED at ${where} — no session, so nothing was tested.\n` +
    "  POST /auth/login is rate-limited 10/min per IP and this probe signs in as\n" +
    "  three accounts; running it straight after the route smoke trips the limiter.\n" +
    "  Wait a minute and re-run.",
  );
  process.exit(2);
}

/** Who is this account's own family? Everything else in the school is foreign. */
async function ownFamily(c) {
  const me = await c.get("/students");
  if (me.status !== 200) return { ids: new Set(), names: new Set() };
  const ids = new Set();
  const names = new Set();
  for (const m of me.text.matchAll(/"id":"([0-9a-f-]{36})"/g)) ids.add(m[1]);
  for (const m of me.text.matchAll(/"name":"([^"]{2,80})"/g)) names.add(m[1]);
  return { ids, names };
}

/**
 * Records belonging to another family, and one that exists nowhere.
 *
 * Read from a STAFF account for the same reason as the roster: asking the parent
 * which records they cannot see would assume the answer.
 */
async function foreignRecords(staff, ownIds) {
  // A STUDENT row's own id is the thing to compare against `ownIds`.
  const pickStudent = (text) => {
    for (const m of text.matchAll(/"id":"([0-9a-f-]{36})"/g)) if (!ownIds.has(m[1])) return m[1];
    return null;
  };

  /**
   * An INVOICE is foreign when its `studentId` is not one of MINE — not when
   * its own id is not.
   *
   * // GOTCHA, and it made this case a false positive that reported a LEAK
   * against a correct API: the original picked the first `"id":"…"` in the
   * invoice list and asked whether it was in `ownIds`, a set of STUDENT ids.
   * An invoice id is never a student id, so "not mine" was vacuously true and
   * it returned whichever invoice happened to be FIRST — including one of the
   * probing parent's own. The parent then legitimately got 200 where the ghost
   * got 404, and the probe called it a leak.
   *
   * Worse than a missed finding: a probe that cries wolf is one whose next
   * report gets waved through. And the invoice case was never really tested —
   * it passed only when the arbitrary pick happened to be somebody else's.
   */
  const pickInvoice = (text) => {
    let rows;
    try {
      const parsed = JSON.parse(text);
      rows = Array.isArray(parsed) ? parsed : (parsed.items ?? []);
    } catch {
      return null;
    }
    for (const r of rows) {
      if (r && typeof r.id === "string" && typeof r.studentId === "string" && !ownIds.has(r.studentId)) {
        return r.id;
      }
    }
    return null;
  };

  const students = await staff.get("/students?kind=student");
  const invoices = await staff.get("/invoices");
  return {
    studentId: students.status === 200 ? pickStudent(students.text) : null,
    invoiceId: invoices.status === 200 ? pickInvoice(invoices.text) : null,
    ghost: "00000000-0000-4000-8000-0000000000ff",
  };
}

const main = async () => {
  const c = client();
  // The roster of everyone else is read from a STAFF account, because a probe
  // that asked the parent who else exists would be assuming the answer it is
  // trying to test.
  const staff = client();
  if (!(await staff.login(process.env.PROBE_STAFF ?? "admin@demo.school"))) {
    console.error("could not sign in as staff to build the roster — is the stack up and seeded?");
    process.exit(2);
  }
  const roster = await staff.get("/students?kind=student");
  if (roster.status !== 200) {
    console.error(`staff roster read failed (${roster.status}) — cannot build the comparison set`);
    process.exit(2);
  }
  const allIds = [...roster.text.matchAll(/"id":"([0-9a-f-]{36})"/g)].map((m) => m[1]);
  const allNames = [...roster.text.matchAll(/"name":"([^"]{2,80})"/g)].map((m) => m[1]);
  if (allIds.length < 2) {
    console.error(`only ${allIds.length} pupil(s) visible to staff — nothing to compare against`);
    process.exit(2);
  }
  console.log(`roster: ${allIds.length} pupils in the school\n`);

  let findings = 0;
  for (const who of AS) {
    if (!(await c.login(who))) {
      console.error(`could not sign in as ${who}`);
      process.exit(2);
    }
    // Prove the session took before drawing any conclusion from a refusal.
    abortIfUnauthenticated((await c.get("/notifications")).status, `sign-in as ${who}`);
    const own = await ownFamily(c);
    const foreignIds = allIds.filter((id) => !own.ids.has(id));
    // Longest first: a short name is a substring of a longer one.
    const foreignNames = allNames.filter((n) => !own.names.has(n)).sort((a, b) => b.length - a.length);
    // What THIS account can reach, computed from its own session permissions.
    const perms = await c.permissions();
    const reachable = perms.length > 0 ? reachableGets(perms) : { paths: [], skipped: [] };
    const probing = [...new Set([...PATHS, ...reachable.paths])];
    console.log(
      `--- ${who} (own family: ${own.ids.size}; ${probing.length} routes, ` +
        `${reachable.skipped.length} parameterised and not covered here) ---`,
    );
    for (const path of probing) {
      const r = await c.get(path);
      abortIfUnauthenticated(r.status, path);
      if (r.status !== 200) {
        console.log(`  ${r.status} ${path}`);
        continue;
      }
      const idHits = foreignIds.filter((id) => r.text.includes(id));
      const nameHits = foreignNames.filter((n) => r.text.includes(n));
      if (idHits.length || nameHits.length) {
        findings += 1;
        console.log(
          `  LEAK ${path} — ${idHits.length} id(s), ${nameHits.length} name(s), e.g. ${nameHits[0] ?? idHits[0]}`,
        );
      } else {
        console.log(`  ok   ${path} (${r.text.length}B)`);
      }
    }
    console.log("");
  }
  // --- part two: naming another family's record directly --------------------
  const own = await (async () => { await c.login(AS[0]); return ownFamily(c); })();
  const foreign = await foreignRecords(staff, own.ids);
  // Real ids for the OTHER parameters, so a route like
  // /term-results/report/:studentId/:sessionId can be asked at all. They come
  // from a staff account: a session or term the family cannot see would make
  // every such probe 404 for the wrong reason and quietly prove nothing.
  const first = (text) => (/"id":"([0-9a-f-]{36})"/.exec(text) ?? [])[1] ?? null;
  const sessions = await staff.get("/academic/sessions");
  const terms = await staff.get("/attendance/terms");
  const classes = await staff.get("/classes/overview");
  const fixtures = {
    sessionId: sessions.status === 200 ? first(sessions.text) : null,
    termId: terms.status === 200 ? first(terms.text) : null,
    classId: classes.status === 200 ? first(classes.text) : null,
  };
  // Say WHICH record was used. A probe that reports "ok" without naming what it
  // asked about cannot be told apart from one that asked about nothing.
  console.log(`id-addressed checks use pupil ${foreign.studentId ?? "(none)"}, ghost ${foreign.ghost}\n`);
  if (!foreign.studentId) {
    console.log("(skipping the id-addressed checks — no second family in this school)");
  } else {
    for (const who of AS) {
      await c.login(who);
      console.log(`--- ${who}: naming another family's records ---`);
      // DERIVED id-addressed cases: every reachable route that takes a pupil's
      // id, asked about somebody else's child.
      //
      // This is where an id-addressed leak actually lives — `/reportcards/
      // :studentId/remarks` is another child's report-card remarks, and no
      // listing endpoint would ever have shown it. The hand-written cases below
      // stay because they name the records that matter most; these add every
      // route the permission set can reach without anyone maintaining a list.
      const perms = await c.permissions();
      const derived = [];
      if (perms.length > 0) {
        for (const route of reachableGets(perms).skipped) {
          const filled = route
            .replace(/:studentId\b/g, foreign.studentId)
            .replace(/:sessionId\b/g, fixtures.sessionId ?? "")
            .replace(/:termId\b/g, fixtures.termId ?? "")
            .replace(/:classId\b/g, fixtures.classId ?? "");
          // Only routes whose every parameter could be filled, and only those
          // that actually name a pupil — anything else would be probing a
          // random id and reporting noise.
          if (filled.includes(":") || filled.includes("//")) continue;
          if (!route.includes(":studentId")) continue;
          derived.push([`their ${route}`, filled]);
        }
      }
      const cases = [
        ...derived,
        ["their profile", `/students/${foreign.studentId}`],
        ["their contacts", `/students/${foreign.studentId}/contacts`],
        ["their guardians", `/students/${foreign.studentId}/guardians`],
        ["their medical record", `/students/${foreign.studentId}/medical`],
        ["their attendance", `/students/${foreign.studentId}/attendance`],
        ["their privacy export", `/privacy/export/${foreign.studentId}`],
        ...(foreign.invoiceId ? [["their invoice", `/invoices/${foreign.invoiceId}`]] : []),
      ];
      for (const [label, path] of cases) {
        const ghostPath = path.replace(foreign.studentId, foreign.ghost).replace(foreign.invoiceId ?? "@", foreign.ghost);
        const real = await c.get(path);
        const ghost = await c.get(ghostPath);
        abortIfUnauthenticated(real.status, label);
        abortIfUnauthenticated(ghost.status, label);
        // The finding is a DIFFERENCE, never a status on its own: a 403 that a
        // non-existent id also gets is the permission guard, and discloses
        // nothing about whether the record is there.
        if (real.status !== ghost.status) {
          findings += 1;
          console.log(`  LEAK ${label} — real ${real.status} vs non-existent ${ghost.status}`);
          continue;
        }
        // A MATCHING STATUS IS NOT A MATCHING ANSWER, and comparing only the
        // status was a blind spot proved by removing a real control: with
        // `assertCanRead` deleted, /reportcards/:studentId/remarks returned 200
        // carrying another family's child — and a non-existent id returned 200
        // with an empty body, so the statuses agreed and the probe said "ok".
        //
        // So when both are 200, compare the BODIES with the requested id
        // stripped out (an endpoint that merely echoes the id back differs
        // without disclosing anything). Anything left over is data that exists
        // only because that child does.
        if (real.status === 200) {
          const strip = (t, id) => t.split(id).join("<id>");
          const a = strip(strip(real.text, foreign.studentId), foreign.invoiceId ?? "\u0000");
          const b = strip(ghost.text, foreign.ghost);
          if (a !== b) {
            findings += 1;
            console.log(`  LEAK ${label} — 200 for another family's child, and its body differs from a non-existent id's`);
            continue;
          }
        }
        console.log(`  ok   ${label} (${real.status}, same as a non-existent id)`);
      }
      console.log("");
    }
  }

  console.log(findings === 0 ? "PASS — no response carried another family's child, and no status distinguished a real record from a ghost" : `FAIL — ${findings} finding(s)`);
  process.exit(findings === 0 ? 0 : 1);
};

main().catch((e) => {
  console.error(e);
  process.exit(2);
});
