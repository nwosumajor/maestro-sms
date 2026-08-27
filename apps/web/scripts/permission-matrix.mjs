// =============================================================================
// Permission matrix — what each role is GRANTED against what it is SERVED
// =============================================================================
// The third probe in this family. isolation-probe.mjs asks whether school A can
// reach school B; family-scope-probe.mjs asks whether one parent can reach
// another family's child; this one asks the staff question: does any role
// receive rows from an endpoint whose permission it does not hold?
//
// WHAT IT DOES NOT CATCH, stated first because I built it believing otherwise.
// The defect that prompted it — `board` being served all 500 pupils by name from
// GET /students — is invisible here, and I proved that by reinstating the bug and
// watching this probe still report PASS. The reason is exact: board DOES hold
// class.read, the permission that route declares. What it lacked was
// enrollment.read, which the SERVICE uses to decide how much of the payload to
// return. A route's decorator is one permission; the finer grants that shape its
// rows are invisible from outside.
//
// So this covers the coarser property only: no role is served rows from an
// endpoint whose DECLARED permission it does not hold. Payload-shaping grants
// need a test that knows the rule — for that case,
// apps/api/test/lms/oversight-sees-shape-not-children.spec.ts, which was
// mutation-checked against exactly this bug.
//
// TWO THINGS MAKE THE OUTPUT MEAN ANYTHING, and the first version of this had
// neither:
//
//   THE MAP IS DERIVED, NOT TYPED. Route -> permission is parsed out of the
//   controllers at run time, including the bare `@Get()` form whose path lives
//   on @Controller. Hand-writing that table produced three wrong mappings and
//   three that silently resolved to nothing, which made a clean-looking result
//   worthless.
//
//   THE DATABASE NEEDS DATA. On an empty module every role reads zero rows and
//   the probe cannot tell "refused" from "nothing there". Seed the modules
//   first; a run against an empty library proves nothing about the library.
//
// WHAT COUNTS AS A FINDING is only the first section. A role holding a
// permission and reading zero rows is usually just an empty table, and a 403 on
// a route whose service applies a NARROWER rule than its decorator is normal —
// `timetable/load` declares timetable.read and then requires a school-wide role,
// and the page gates on the narrower condition so no user meets the refusal.
//
// Usage:
//   WEB_URL=http://localhost pnpm --filter @sms/web probe:permissions
// =============================================================================

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

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
const API_SRC = join(process.cwd(), "..", "api", "src");
const TYPES_SRC = join(process.cwd(), "..", "..", "packages", "types", "src", "permissions");

const walk = (dir) =>
  readdirSync(dir).flatMap((e) => {
    const p = join(dir, e);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });

/** Every `<DOMAIN>_PERMISSIONS.KEY` resolved to the string it actually is. */
function permissionConstants() {
  const out = new Map();
  for (const f of walk(TYPES_SRC).filter((p) => p.endsWith(".ts"))) {
    const src = readFileSync(f, "utf8");
    for (const m of src.matchAll(/export const (\w+_PERMISSIONS)\s*=\s*\{([\s\S]*?)\n\}/g)) {
      for (const [, k, v] of m[2].matchAll(/(\w+)\s*:\s*"([^"]+)"/g)) out.set(`${m[1]}.${k}`, v);
    }
  }
  return out;
}

/** Permission-gated GET routes with no path parameter, and the permission each needs. */
function routes(consts) {
  const found = new Map();
  for (const f of walk(API_SRC).filter((p) => p.endsWith(".controller.ts"))) {
    const src = readFileSync(f, "utf8");
    const prefixes = [...src.matchAll(/@Controller\("([^"]*)"\)/g)].map((m) => [m.index, m[1]]);
    for (const m of src.matchAll(/@Get\((?:"([^"]*)")?\)((?:\s*@[\w.]+\([^\n]*\)\s*)*)/g)) {
      const path = m[1] ?? "";
      if (path.includes(":")) continue;
      let pre = "";
      for (const [pos, p] of prefixes) if (pos < m.index) pre = p;
      if (pre.includes(":")) continue;
      const perm = /@RequirePermission\((\w+_PERMISSIONS\.\w+)\)/.exec(m[2]);
      const key = perm && consts.get(perm[1]);
      if (!key) continue;
      const full = [pre, path].filter(Boolean).join("/");
      if (!found.has(full)) found.set(full, key);
    }
  }
  return [...found].map(([path, perm]) => ({ path, perm }));
}

/** role -> its granted permissions, read from the database the app is using. */
function grantsByRole() {
  const sql = `select r.name, string_agg(p.key, ',' order by p.key) from role r
     join role_permission rp on rp."roleId"=r.id join permission p on p.id=rp."permissionId"
     where r.name not in ('super_admin','manager_admin') group by r.name order by r.name`;
  const raw = execFileSync(
    "docker",
    ["compose", "-f", join(process.cwd(), "..", "..", "infrastructure", "docker-compose.yml"),
     "exec", "-T", "postgres", "psql", "-U", "postgres", "-d", "sms", "-tAc", sql],
    { encoding: "utf8" },
  );
  return raw.trim().split("\n").filter(Boolean).map((l) => {
    const [name, perms] = l.split("|");
    return [name.trim(), new Set((perms ?? "").split(","))];
  });
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
        method: "POST", redirect: "manual",
        headers: { "content-type": "application/x-www-form-urlencoded", cookie: header() },
        body: new URLSearchParams({ csrfToken, email, password: PASSWORD, redirect: "false", json: "true" }),
      });
      store(r);
    },
    async get(path) {
      const res = await fetch(`${WEB}/api/sms/${path}`, { headers: { cookie: header() }, redirect: "manual" });
      let d = null;
      try { d = await res.json(); } catch { /* not json */ }
      return { status: res.status, d };
    },
  };
}

const EMAIL = { school_admin: "admin", hr_clerk: "hr", hr_manager: "hrmanager", head_teacher: "headteacher",
  head_admin: "headadmin", head_warden: "headwarden", head_driver: "headdriver" };

const main = async () => {
  const consts = permissionConstants();
  const ROUTES = routes(consts);
  const ROLES = grantsByRole();
  console.log(`${consts.size} permission constants, ${ROUTES.length} gated GET routes, ${ROLES.length} roles\n`);
  if (ROUTES.length < 50) { console.error("route scan found too little — wrong working directory?"); process.exit(2); }

  const c = client();
  const over = [];
  let probed = 0, skipped = 0;
  for (const [role, grants] of ROLES) {
    await c.login(`${EMAIL[role] ?? role}@demo.school`);
    // Prove the session took. A rate-limited or missing account answers 401 to
    // everything, which would otherwise read as "refused" for every route.
    if ((await c.get("notifications")).status === 401) {
      console.log(`  skip ${role} — no session (missing account, or the 10/min login limiter)`);
      skipped += 1;
      continue;
    }
    for (const r of ROUTES) {
      const res = await c.get(r.path);
      probed += 1;
      if (res.status !== 200) continue;
      const arr = Array.isArray(res.d) ? res.d : res.d?.items ?? null;
      const rows = arr ? arr.length : -1;
      if (!grants.has(r.perm) && rows !== 0) over.push({ role, path: r.path, perm: r.perm, rows });
    }
    process.stdout.write(`  ${role}\n`);
    // The login limiter is 10/min per IP and this signs in once per role.
    await new Promise((res) => setTimeout(res, 7000));
  }

  console.log(`\nprobed ${probed} role/route pairs (${skipped} role(s) skipped)`);
  if (over.length === 0) {
    console.log("PASS — no role was served rows from an endpoint whose permission it lacks");
    process.exit(0);
  }
  console.log(`FAIL — ${over.length} over-exposure(s):`);
  for (const o of over) console.log(`  ${o.role.padEnd(14)} ${o.path.padEnd(34)} lacks ${o.perm} -> ${o.rows === -1 ? "object" : `${o.rows} rows`}`);
  process.exit(1);
};

main().catch((e) => { console.error(e); process.exit(2); });
