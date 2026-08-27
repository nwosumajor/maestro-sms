// =============================================================================
// Cross-tenant isolation probe — the most important test category, end to end
// =============================================================================
// The repo already proves isolation two ways: `rls.e2e-spec.ts` proves every one
// of the ~200 tenant TABLES denies a cross-tenant read at the database, and each
// module unit-tests its own scoping logic. Neither exercises the thing a real
// breach would actually look like:
//
//   a legitimate, fully-privileged admin of school A, signed in through the
//   real front door, asking for school B's records BY ID over HTTP.
//
// That path runs through the session cookie, the BFF, the JWT, the permission
// guard, the service's relationship scoping and finally RLS. Every one of those
// layers is individually tested; the composition was not tested at all, and a
// composition is exactly where a deliberate tenant-boundary crossing (the
// operator console, the group console, an exit workflow, a records export) can
// be wired up correctly in isolation and wrongly in place.
//
// Deliberately ID-ADDRESSED. Listing endpoints are the easy case — RLS empties
// them and nothing leaks. The interesting question is what happens when the
// caller already knows a valid id from another school, which is the position an
// attacker is in after any partial disclosure, and the position a support agent
// is in by accident.
//
// EXPECTED RESULT: every probe denied. 404 rather than 403 for out-of-scope
// records, because a 403 confirms the record exists.
//
// A 200 IS NOT AUTOMATICALLY A LEAK. A list endpoint answering with an empty
// page discloses nothing, and this script says so rather than crying wolf — the
// first run of this probe reported a "LEAK" that was `{"items":[],...}`.
//
// PROVING THE PROBE IS NOT VACUOUS. A check that can only ever pass is worth
// nothing, so there is a positive control that needs no sabotage:
//
//   PROBE_AS=owner@sms.platform pnpm --filter @sms/web isolation:probe
//
// The platform owner legitimately holds platform.tenants.read, so the two
// operator probes come back 200 with real data and the run FAILS — which is the
// probe correctly detecting cross-school data. Do not read that run as a breach.
//
// That control also demonstrates the invariant the codebase went to some
// trouble for: the owner is refused all TEN student-record probes. super_admin
// has no standing role scope over a tenant's data; the supported route in is
// impersonation, which is step-up gated and audited by name.
//
// Usage:  pnpm --filter @sms/web isolation:probe
//         WEB_URL=http://localhost pnpm --filter @sms/web isolation:probe
// =============================================================================

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
const ATTACKER = process.env.PROBE_AS ?? "admin@demo.school";
const OWNER = process.env.PROBE_OWNER ?? "owner@sms.platform";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
    async session() {
      const r = await fetch(`${WEB}/api/auth/session`, { headers: { cookie: header() } });
      return r.text();
    },
    async call(method, path, body) {
      const res = await fetch(`${WEB}/api/sms${path}`, {
        method,
        headers: { cookie: header(), ...(body ? { "content-type": "application/json" } : {}) },
        body: body ? JSON.stringify(body) : undefined,
        redirect: "manual",
      });
      return { status: res.status, text: await res.text() };
    },
  };
}

/** Denied = refused outright, or answered with nothing. See the note above. */
function classify(res) {
  if (res.status === 404 || res.status === 403) return { denied: true, why: "refused" };
  if (res.status >= 400) return { denied: true, why: `refused (${res.status})` };
  const body = res.text ?? "";
  // An empty collection discloses nothing. Anything else at 2xx is real data.
  if (/^\s*(\[\s*\]|\{\s*"items"\s*:\s*\[\s*\][^}]*\}|\{\s*"rows"\s*:\s*\[\s*\][^}]*\})\s*$/.test(body)) {
    return { denied: true, why: "empty" };
  }
  return { denied: false, why: `200 with ${body.length} bytes of body` };
}

async function main() {
  const owner = makeClient();
  if (!(await owner.login(OWNER))) {
    console.error(`Could not sign in as ${OWNER} — the probe needs the platform owner to find a second school.`);
    process.exit(2);
  }
  // Find a school the attacker does NOT belong to, and one real id inside it.
  const tenants = JSON.parse((await owner.call("GET", "/operator/tenants?page=1")).text ?? "{}");
  const rows = tenants.tenants ?? tenants.rows ?? tenants.items ?? [];
  const attacker = makeClient();
  if (!(await attacker.login(ATTACKER))) {
    console.error(`Could not sign in as ${ATTACKER}.`);
    process.exit(2);
  }
  // The caller's own school comes from their SESSION, not from a claim they
  // could influence — the same source the app itself trusts.
  const session = JSON.parse((await attacker.session()) || "{}");
  const mySchool = session?.user?.schoolId;
  if (!mySchool) {
    console.error(`Could not read ${ATTACKER}'s school from their session.`);
    process.exit(2);
  }
  // A school that is not the caller's AND actually has pupils to reach for —
  // probing an empty school would pass for the wrong reason.
  const target = rows.find((t) => (t.schoolId ?? t.id) !== mySchool && (t.students ?? 0) > 0);
  if (!target) {
    console.error("No second school with students — provision one before running this probe.");
    process.exit(2);
  }
  const targetSchool = target.schoolId ?? target.id;
  const students = JSON.parse((await owner.call("GET", `/operator/tenants/${targetSchool}/students`)).text ?? "[]");
  const victim = (Array.isArray(students) ? students : students.rows ?? [])[0];
  if (!victim) {
    console.error(`${target.name ?? targetSchool} has no students to probe for.`);
    process.exit(2);
  }

  console.log(`Signed in as ${ATTACKER}, reaching for "${target.name ?? targetSchool}" records by id.\n`);
  const probes = [
    ["their student's profile", "GET", `/students/${victim.id}/profile`],
    ["their student's contacts", "GET", `/students/${victim.id}/contacts`],
    ["their student's MEDICAL record", "GET", `/students/${victim.id}/medical`],
    ["their student's exit preview", "GET", `/students/${victim.id}/exit/preview`],
    ["raising an exit for their pupil", "POST", `/students/${victim.id}/exit`, { kind: "WITHDRAWN" }],
    ["re-admitting their pupil", "POST", `/students/${victim.id}/readmit`, {}],
    ["their student's report card", "POST", `/reportcards/${victim.id}/generate`, {}],
    ["their student's NDPR export", "GET", `/privacy/export/${victim.id}`],
    ["their invoices by student", "GET", `/invoices?studentId=${victim.id}`],
    ["their school via the group console", "GET", `/group/schools/${targetSchool}`],
    ["their subscription (operator)", "GET", `/operator/tenants/${targetSchool}/subscription`],
    ["their pupils (operator)", "GET", `/operator/tenants/${targetSchool}/students`],
    ["their audit trail (operator)", "GET", `/operator/tenants/${targetSchool}/audit`],
    ["impersonating one of them", "POST", `/operator/impersonate`, { schoolId: targetSchool, userId: victim.id }],
  ];

  let leaked = 0;
  for (const [label, method, path, body] of probes) {
    const res = await attacker.call(method, path, body);
    const { denied, why } = classify(res);
    if (!denied) leaked++;
    console.log(`  ${denied ? "denied " : "LEAK!! "} ${String(res.status).padEnd(4)} ${label}  (${why})`);
    await sleep(60);
  }

  console.log("");
  if (leaked) {
    console.log(`ISOLATION PROBE FAILED — ${leaked} of ${probes.length} returned another school's data.`);
    process.exit(1);
  }
  console.log(`ISOLATION PROBE PASSED — all ${probes.length} probes denied.`);
}

main().catch((e) => {
  console.error("PROBE ERROR:", e.message);
  if (/fetch failed|ECONNREFUSED/i.test(String(e.message))) {
    console.error(`  nothing answered at ${WEB}. Set WEB_URL — the compose stack is http://localhost (nginx), a dev server is http://localhost:3000.`);
  }
  process.exit(2);
});
