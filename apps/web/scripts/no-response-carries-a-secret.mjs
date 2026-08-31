// =============================================================================
// No response carries ciphertext or a credential
// =============================================================================
// Some values must never leave the API in a response body, whoever is asking:
//
//   * FIELD-ENCRYPTED CIPHERTEXT (`enc:v1:…`) — medical notes, salaries,
//     payslip breakdowns, bank details, next of kin, a saved card
//     authorization. It is encrypted at rest precisely so a leak is not a
//     disclosure, and shipping the blob to a browser makes the ciphertext a
//     durable artefact somebody else holds.
//   * CREDENTIAL MATERIAL — a bcrypt hash, a TOTP secret, a gateway secret key.
//
// This is a FIELD-level question, and it is the half that goes unexamined once
// row scoping is right. This repo has been bitten by it twice: a deny-list
// mapper that shipped encrypted staff PII, and a driver — the role scoped most
// tightly in the product — correctly limited to their own 15 seat assignments
// and handed every child's fare on them.
//
// A one-off audit found the first of those and was never made repeatable, so
// nothing has asked the question since. The value is in running it after the
// NEXT mapper is written, which is the same argument the no-500 probe makes
// about itself.
//
// WHAT IS NOT A FINDING: 400/403/404 are answers, and an empty list is an
// answer. Only a 2xx body carrying a marker counts.
//
// Needs a running stack and is not in CI, like the other probes. It signs in as
// several accounts and `POST /auth/login` is rate-limited 10/min per IP, so
// running two probes back to back can fail on the LIMITER rather than the
// stack — the summary says which.
//
// Usage:
//   WEB_URL=http://localhost pnpm --filter @sms/web probe:no-secrets
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
 * Every parameterless GET the API declares.
 *
 * DERIVED, never listed: a hand-kept route table is what this repo has watched
 * rot in four places. The nearest `@Controller` above a route wins, because
 * several files declare two.
 */
function getRoutes() {
  const out = [];
  for (const f of walk(API_SRC).filter((p) => p.endsWith(".controller.ts"))) {
    const src = readFileSync(f, "utf8");
    const prefixes = [...src.matchAll(/@Controller\(\s*"([^"]*)"\s*\)/g)].map((m) => [m.index, m[1]]);
    for (const m of src.matchAll(/@Get\(\s*(?:"([^"]*)")?\s*\)/g)) {
      let pre = "";
      for (const [pos, p] of prefixes) if (pos < m.index) pre = p;
      const full = [pre, m[1] ?? ""].filter(Boolean).join("/");
      // Binary streams are not JSON and a PDF legitimately contains anything.
      if (!full || full.includes(":") || /\.(pdf|csv)$/.test(full)) continue;
      out.push(full);
    }
  }
  return [...new Set(out)];
}

/**
 * Markers that are never legitimate in a response body.
 *
 * Deliberately UNAMBIGUOUS. A rule wide enough to catch "anything that looks
 * sensitive" is the over-wide gate this repo treats as the same failure as a
 * blind one, because it teaches the next reader to add an exemption.
 */
const MARKERS = [
  ["enc:v1:", "field-encrypted ciphertext"],
  ["$2a$", "bcrypt hash"],
  ["$2b$", "bcrypt hash"],
  ["$2y$", "bcrypt hash"],
  ["sk_live_", "gateway secret key"],
  ["sk_test_", "gateway secret key"],
  ['"passwordHash"', "password hash field"],
  ['"mfaSecret"', "TOTP secret field"],
  ['"totpSecret"', "TOTP secret field"],
  ['"targetSecret"', "server-only game secret"],
];

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
      const body = res.status >= 200 && res.status < 300 ? await res.text() : "";
      return { status: res.status, body };
    },
  };
}

// Every seeded role, because the question is per-ROLE: a mapper can be careful
// for the family and careless for staff, or the reverse.
const ROLES = [
  "principal", "admin", "teacher", "parent", "student", "accountant", "hr",
  "hrmanager", "headteacher", "headadmin", "warden", "driver", "headwarden",
  "headdriver", "librarian", "board", "junioradmin",
];

async function main() {
  const routes = getRoutes();
  // A walk that finds nothing passes every check below, so say the size out
  // loud and refuse a run that plainly did not read the controllers.
  console.log(`${routes.length} parameterless GET routes`);
  if (routes.length < 100) {
    console.error("PROBE ERROR: too few routes extracted — the controllers were not read. Run from apps/web.");
    process.exit(4);
  }

  const s = session();
  const findings = [];
  let probes = 0;
  let signedIn = 0;
  const skipped = [];

  for (const role of ROLES) {
    // PROVE THE SESSION TOOK. A rate-limited or missing account answers 401 to
    // everything, which carries no marker — so the sweep would run green having
    // tested nothing. The isolation and family probes were both wrong this way.
    //
    // ONE RETRY, AFTER A WAIT, is what separates the two causes. `POST
    // /auth/login` is 10/min per IP and this signs in as seventeen accounts, so
    // the limiter is not an edge case here — it is certain. A TRANSIENT limit
    // clears; a MISSING account does not, and only that survives to the summary.
    let ok = false;
    for (const attempt of [0, 1]) {
      if (attempt === 1) {
        process.stdout.write(`  ${role}: rate-limited, waiting for the window…\n`);
        await new Promise((r) => setTimeout(r, 61_000));
      }
      await s.login(`${role}@demo.school`);
      if ((await s.get("notifications?page=1")).status !== 401) {
        ok = true;
        break;
      }
    }
    if (!ok) {
      skipped.push(role);
      continue;
    }
    signedIn += 1;
    for (const p of routes) {
      probes += 1;
      const r = await s.get(p);
      if (!r.body) continue;
      for (const [marker, what] of MARKERS) {
        if (r.body.includes(marker)) {
          const at = r.body.indexOf(marker);
          findings.push(
            `${role} GET /${p} -> ${what} (${marker})\n      …${r.body.slice(Math.max(0, at - 60), at + 40)}…`,
          );
          break;
        }
      }
    }
  }

  if (signedIn === 0) {
    console.error("PROBE ERROR: no role signed in — is the stack up and seeded?");
    process.exit(3);
  }
  console.log(`probed ${probes} (role, route) pairs across ${signedIn} role(s)`);

  if (findings.length > 0) {
    console.error(`\nLEAK — ${findings.length} response(s) carried a secret:\n`);
    for (const f of findings) console.error(`  ${f}`);
    process.exit(1);
  }
  // A skipped role is NOT a passed one, and saying so is what separates this
  // from the false-negative the other probes shipped with.
  if (skipped.length > 0) {
    console.error(
      `\nINCOMPLETE — ${skipped.length} role(s) were never signed in and so were not tested: ${skipped.join(", ")}.\n` +
        `Re-run (the login limiter is 10/min per IP), or check those accounts exist.`,
    );
    process.exit(3);
  }
  console.log("\nNO RESPONSE CARRIED A SECRET — no ciphertext or credential material in any body.");
}

main().catch((e) => {
  console.error("PROBE ERROR:", e.message);
  process.exit(2);
});
