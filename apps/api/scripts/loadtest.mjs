#!/usr/bin/env node
// =============================================================================
// SMS API load-test / capacity harness  (scaling program — Phase 8)
// =============================================================================
// Seeds N synthetic tenants, drives concurrent MULTI-TENANT read traffic across
// them, and reports latency percentiles, throughput, error rate, and peak DB
// connections — so every scaling change (pooling, replicas, caching, sharding)
// is MEASURED against a real baseline instead of believed.
//
// It is deliberately self-contained (pg + jsonwebtoken + built-in fetch; no new
// deps) and NON-DESTRUCTIVE: every row it writes is tagged `loadtest-<runId>-…`
// and removed on exit (pass --keep to inspect). It only ever touches its own
// synthetic tenants, never real school data.
//
// Usage (run against a LOCAL / staging stack — never production):
//   AUTH_SECRET=… LOADTEST_ADMIN_URL=postgres://superuser@host:5432/sms \
//     node apps/api/scripts/loadtest.mjs --schools 20 --users 5 \
//       --concurrency 50 --duration 20
//
// Flags:  --schools N  --users M  --concurrency C  --duration S(econds)  --keep
// Env:    API_URL (default http://localhost:3001), AUTH_SECRET (mint tokens),
//         LOADTEST_ADMIN_URL (superuser DSN — seed/cleanup/connection sampling).
// =============================================================================

import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";

// pg + jsonwebtoken live in apps/api/node_modules; resolve from there.
const require = createRequire(new URL("../package.json", import.meta.url));
const { Client } = require("pg");
const jwt = require("jsonwebtoken");

// ---- config -----------------------------------------------------------------
const arg = (name, def) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith("--")
    ? process.argv[i + 1]
    : def;
};
const flag = (name) => process.argv.includes(`--${name}`);

const SCHOOLS = Number(arg("schools", "20"));
const USERS = Number(arg("users", "5"));
const CONCURRENCY = Number(arg("concurrency", "50"));
const DURATION = Number(arg("duration", "20")); // seconds
const KEEP = flag("keep");

const API = process.env.API_URL ?? "http://localhost:3001";
const SECRET = process.env.AUTH_SECRET;
const ADMIN_URL = process.env.LOADTEST_ADMIN_URL;
const RUN_ID = randomUUID().slice(0, 8);

if (!SECRET) fail("AUTH_SECRET is required (to mint synthetic session tokens).");
if (!ADMIN_URL) fail("LOADTEST_ADMIN_URL is required (superuser DSN for seeding/cleanup).");

// Endpoints under test. All READ paths — reads are 80–95% of real school traffic
// and the target of the read/write-split + caching phases. `auth:false` = the
// no-DB /health baseline (isolates network + framework overhead from DB cost).
// `weight` biases the random mix toward the hottest endpoints.
const ENDPOINTS = [
  { key: "health", path: "/health", weight: 1, auth: false },
  { key: "analytics", path: "/analytics/overview", weight: 2, auth: true }, // replica read path (Phase 1)
  { key: "notifications", path: "/notifications", weight: 3, auth: true },
  { key: "classes-mine", path: "/classes/mine", weight: 1, auth: true },
  { key: "students", path: "/students", weight: 1, auth: true },
];

// Broad staff token: school_admin (staff-wide analytics scope) + the read perms
// the target routes require. ENTERPRISE subscription (seeded default) unlocks the
// ANALYTICS + LMS module gates.
const TOKEN_PERMS = ["notification.read", "class.read"];
const TOKEN_ROLES = ["school_admin"];

function fail(msg) {
  console.error(`\n  ✗ ${msg}\n`);
  process.exit(1);
}

function mintToken(userId, schoolId) {
  return jwt.sign(
    { userId, school_id: schoolId, roles: TOKEN_ROLES, permissions: TOKEN_PERMS },
    SECRET,
    { algorithm: "HS256", expiresIn: "2h" },
  );
}

// ---- seeding ----------------------------------------------------------------
// Minimal, robust seed: school + (bare = ENTERPRISE/ACTIVE) subscription + users.
// The read endpoints run their full RLS-scoped query set even over an empty
// tenant, so this measures the real query/scoping/routing cost without fragile
// multi-table fixtures. Raise --users to fan token identities wider.
async function seed(db) {
  const schools = [];
  const schoolRows = [];
  const subRows = [];
  const userRows = [];
  for (let s = 0; s < SCHOOLS; s++) {
    const schoolId = randomUUID();
    const slug = `loadtest-${RUN_ID}-${s}`;
    schoolRows.push(`('${schoolId}','LoadTest ${s}','${slug}',now())`);
    subRows.push(`('${randomUUID()}','${schoolId}',now())`);
    const tokens = [];
    for (let u = 0; u < USERS; u++) {
      const userId = randomUUID();
      userRows.push(
        `('${userId}','${schoolId}','lt_${RUN_ID}_${s}_${u}@loadtest.local','LT User','x',now())`,
      );
      tokens.push(mintToken(userId, schoolId));
    }
    schools.push({ schoolId, tokens });
  }
  // Bulk insert (chunked to stay under parameter/statement limits).
  await bulk(db, `INSERT INTO school (id,name,slug,"updatedAt") VALUES `, schoolRows);
  await bulk(db, `INSERT INTO school_subscription (id,"schoolId","updatedAt") VALUES `, subRows);
  await bulk(
    db,
    `INSERT INTO "user" (id,"schoolId",email,name,"passwordHash","updatedAt") VALUES `,
    userRows,
  );
  return schools;
}

async function bulk(db, prefix, rows, chunk = 500) {
  for (let i = 0; i < rows.length; i += chunk) {
    await db.query(prefix + rows.slice(i, i + chunk).join(","));
  }
}

async function cleanup(db) {
  // FK order: children (user) before parents (subscription, school). Everything
  // is keyed by our run's slug/email tag, so we never touch real tenants.
  await db.query(`DELETE FROM "user" WHERE email LIKE 'lt_${RUN_ID}_%@loadtest.local'`);
  await db.query(
    `DELETE FROM school_subscription WHERE "schoolId" IN (SELECT id FROM school WHERE slug LIKE 'loadtest-${RUN_ID}-%')`,
  );
  await db.query(`DELETE FROM school WHERE slug LIKE 'loadtest-${RUN_ID}-%'`);
}

// ---- driver -----------------------------------------------------------------
const pick = (arr) => arr[(Math.random() * arr.length) | 0];
function weightedEndpoints(list) {
  const bag = [];
  for (const e of list) for (let i = 0; i < e.weight; i++) bag.push(e);
  return bag;
}

async function hit(ep, school) {
  const headers = ep.auth ? { authorization: `Bearer ${pick(school.tokens)}` } : {};
  const t0 = performance.now();
  let status = 0;
  try {
    const res = await fetch(API + ep.path, { headers });
    status = res.status;
    await res.arrayBuffer(); // drain the body so timing includes full transfer
  } catch {
    status = 0; // connection refused / socket error
  }
  return { ms: performance.now() - t0, ok: status >= 200 && status < 400, status };
}

async function warmup(schools) {
  // Drop any endpoint that doesn't return <400 for a valid token, so a route
  // rename never silently turns the baseline into an error-rate measurement.
  const live = [];
  for (const ep of ENDPOINTS) {
    const r = await hit(ep, schools[0]);
    if (r.ok) live.push(ep);
    else console.warn(`  ! skipping ${ep.path} — warmup status ${r.status}`);
  }
  if (!live.length) fail("No endpoint passed warmup — is the API running at " + API + "?");
  return live;
}

function pctl(sorted, p) {
  if (!sorted.length) return 0;
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)];
}

async function run(db, schools, endpoints) {
  const stats = new Map(endpoints.map((e) => [e.key, { ms: [], ok: 0, err: 0 }]));
  const bag = weightedEndpoints(endpoints);
  const deadline = performance.now() + DURATION * 1000;
  let peakConns = 0;

  // Sample live DB connections while the load runs (the metric that decides
  // whether a pooler is needed — connections, not just latency).
  const sampler = setInterval(async () => {
    try {
      const r = await db.query(
        `SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database()`,
      );
      peakConns = Math.max(peakConns, r.rows[0].n);
    } catch {
      /* sampling is best-effort */
    }
  }, 200);

  async function worker() {
    while (performance.now() < deadline) {
      const ep = pick(bag);
      const r = await hit(ep, pick(schools));
      const s = stats.get(ep.key);
      s.ms.push(r.ms);
      if (r.ok) s.ok++;
      else s.err++;
    }
  }

  const wallStart = performance.now();
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  const wallMs = performance.now() - wallStart;
  clearInterval(sampler);
  return { stats, wallMs, peakConns };
}

// ---- report -----------------------------------------------------------------
function report({ stats, wallMs, peakConns }) {
  let total = 0;
  let errors = 0;
  const rows = [];
  for (const [key, s] of stats) {
    const sorted = [...s.ms].sort((a, b) => a - b);
    const n = s.ok + s.err;
    total += n;
    errors += s.err;
    rows.push({
      key,
      n,
      errPct: n ? (100 * s.err) / n : 0,
      p50: pctl(sorted, 50),
      p95: pctl(sorted, 95),
      p99: pctl(sorted, 99),
    });
  }
  const rps = total / (wallMs / 1000);
  const f = (x) => x.toFixed(1).padStart(8);

  console.log("\n" + "=".repeat(72));
  console.log("  SMS API LOAD TEST — capacity baseline");
  console.log("=".repeat(72));
  console.log(
    `  config      : ${SCHOOLS} schools × ${USERS} users, ${CONCURRENCY} concurrent, ${DURATION}s`,
  );
  console.log(`  target      : ${API}`);
  console.log(`  run at      : ${new Date().toISOString()}`);
  console.log("  note        : read routing (replica vs primary) is the API's DATABASE_REPLICA_URL, not the harness's.");
  console.log("-".repeat(72));
  console.log(`  ${"endpoint".padEnd(16)}${"reqs".padStart(8)}${"err%".padStart(8)}${"p50".padStart(8)}${"p95".padStart(8)}${"p99".padStart(8)}  (ms)`);
  for (const r of rows) {
    console.log(
      `  ${r.key.padEnd(16)}${String(r.n).padStart(8)}${r.errPct.toFixed(1).padStart(8)}${f(r.p50)}${f(r.p95)}${f(r.p99)}`,
    );
  }
  console.log("-".repeat(72));
  console.log(`  TOTAL       : ${total} reqs   ${rps.toFixed(0)} req/s   ${((100 * errors) / (total || 1)).toFixed(2)}% errors`);
  console.log(`  peak DB connections during run : ${peakConns}`);
  console.log("=".repeat(72) + "\n");
}

// ---- main -------------------------------------------------------------------
(async () => {
  const db = new Client({ connectionString: ADMIN_URL });
  await db.connect().catch((e) => fail(`cannot connect LOADTEST_ADMIN_URL: ${e.message}`));
  let seeded = false;
  try {
    console.log(`\n  seeding ${SCHOOLS} synthetic tenants (run ${RUN_ID})…`);
    const schools = await seed(db);
    seeded = true;
    console.log(`  warming up ${ENDPOINTS.length} endpoints…`);
    const endpoints = await warmup(schools);
    console.log(`  driving load: ${CONCURRENCY} workers for ${DURATION}s across ${endpoints.length} endpoints…`);
    const result = await run(db, schools, endpoints);
    report(result);
  } finally {
    if (seeded && !KEEP) {
      await cleanup(db).catch((e) => console.error(`  ! cleanup failed: ${e.message}`));
      console.log("  cleaned up synthetic tenants.");
    } else if (KEEP) {
      console.log(`  --keep: left run ${RUN_ID} in place (slug loadtest-${RUN_ID}-*).`);
    }
    await db.end();
  }
})();
