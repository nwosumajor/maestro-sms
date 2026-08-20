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

const WEB = process.env.WEB_URL ?? "http://localhost:3000";
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
  };
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
  const pick = (text, key) => {
    for (const m of text.matchAll(/"id":"([0-9a-f-]{36})"/g)) if (!ownIds.has(m[1])) return m[1];
    return null;
  };
  const students = await staff.get("/students?kind=student");
  const invoices = await staff.get("/invoices");
  return {
    studentId: students.status === 200 ? pick(students.text) : null,
    invoiceId: invoices.status === 200 ? pick(invoices.text) : null,
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
    const own = await ownFamily(c);
    const foreignIds = allIds.filter((id) => !own.ids.has(id));
    // Longest first: a short name is a substring of a longer one.
    const foreignNames = allNames.filter((n) => !own.names.has(n)).sort((a, b) => b.length - a.length);
    console.log(`--- ${who} (own family: ${own.ids.size}) ---`);
    for (const path of PATHS) {
      const r = await c.get(path);
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
  if (!foreign.studentId) {
    console.log("(skipping the id-addressed checks — no second family in this school)");
  } else {
    for (const who of AS) {
      await c.login(who);
      console.log(`--- ${who}: naming another family's records ---`);
      const cases = [
        ["their profile", `/students/${foreign.studentId}`],
        ["their contacts", `/students/${foreign.studentId}/contacts`],
        ["their guardians", `/students/${foreign.studentId}/guardians`],
        ["their medical record", `/students/${foreign.studentId}/medical`],
        ["their attendance", `/students/${foreign.studentId}/attendance`],
        ["their privacy export", `/privacy/export/${foreign.studentId}`],
        ...(foreign.invoiceId ? [["their invoice", `/invoices/${foreign.invoiceId}`]] : []),
      ];
      for (const [label, path] of cases) {
        const real = await c.get(path);
        const ghost = await c.get(path.replace(foreign.studentId, foreign.ghost).replace(foreign.invoiceId ?? "@", foreign.ghost));
        // The finding is a DIFFERENCE, never a status on its own: a 403 that a
        // non-existent id also gets is the permission guard, and discloses
        // nothing about whether the record is there.
        if (real.status !== ghost.status) {
          findings += 1;
          console.log(`  LEAK ${label} — real ${real.status} vs non-existent ${ghost.status}`);
        } else {
          console.log(`  ok   ${label} (${real.status}, same as a non-existent id)`);
        }
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
