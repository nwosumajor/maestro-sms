#!/usr/bin/env node
// =============================================================================
// SMS API load-test / capacity harness  (scaling program — Phase 8)
// =============================================================================
// Seeds N synthetic tenants, drives concurrent MULTI-TENANT traffic across them,
// and reports latency percentiles, throughput, error rate, and peak DB
// connections — so every scaling change (pooling, replicas, caching, sharding)
// is MEASURED against a real baseline instead of believed.
//
// TWO MODES:
//   1. OVERHEAD mode (default, --students 0): empty tenants, read-only. Measures
//      the per-request path (auth → guard → entitlement → tenant tx → RLS) and how
//      it scales with TENANT COUNT. Fast to seed; use for big --schools numbers.
//   2. WORKLOAD mode (--students N): each school gets a real roster — teacher,
//      students (with the student ROLE, so the roster query is real), classes,
//      enrollments, attendance history and invoices — and the mix includes WRITES
//      (take-register: a tx of upserts + an audit_log insert, the real high-volume
//      school-day write). This is the mode that measures query cost over real data
//      and write throughput on the primary. Seeding dominates, so use fewer schools.
//
// It is deliberately self-contained (pg + jsonwebtoken + built-in fetch; no new
// deps) and NON-DESTRUCTIVE: every row it writes is tagged `loadtest-<runId>-…`
// and removed on exit (pass --keep to inspect). It only ever touches its own
// synthetic tenants, never real school data.
//
// Usage (run against a LOCAL / staging stack — never production):
//   AUTH_SECRET=… LOADTEST_ADMIN_URL=postgres://superuser@host:5432/sms \
//     node apps/api/scripts/loadtest.mjs --schools 20 --students 60 --write-pct 20
//
// Flags:
//   --schools N     tenants to seed                       (default 20)
//   --users M       users/school in OVERHEAD mode         (default 5)
//   --students N    students/school → WORKLOAD mode       (default 0 = overhead)
//   --classes C     classes/school (workload)             (default 3)
//   --days D        days of attendance history (workload) (default 20)
//   --write-pct P   % of requests that are WRITES         (default 0)
//   --concurrency C in-flight workers                     (default 50)
//   --duration S    seconds of load                       (default 20)
//   --keep          leave seeded data behind for inspection
// Env: API_URL (default http://localhost:3001), AUTH_SECRET (mint tokens),
//      LOADTEST_ADMIN_URL (superuser DSN — seed/cleanup/connection sampling).
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
const STUDENTS = Number(arg("students", "0"));
const CLASSES = Number(arg("classes", "3"));
const DAYS = Number(arg("days", "20"));
const WRITE_PCT = Number(arg("write-pct", "0"));
const CONCURRENCY = Number(arg("concurrency", "50"));
const DURATION = Number(arg("duration", "20")); // seconds
const KEEP = flag("keep");
const WORKLOAD = STUDENTS > 0;

const API = process.env.API_URL ?? "http://localhost:3001";
const SECRET = process.env.AUTH_SECRET;
const ADMIN_URL = process.env.LOADTEST_ADMIN_URL;
const RUN_ID = randomUUID().slice(0, 8);

if (!SECRET) fail("AUTH_SECRET is required (to mint synthetic session tokens).");
if (!ADMIN_URL) fail("LOADTEST_ADMIN_URL is required (superuser DSN for seeding/cleanup).");
if (WRITE_PCT > 0 && !WORKLOAD) fail("--write-pct needs --students N (writes need a real roster).");

const today = new Date().toISOString().slice(0, 10);

// Endpoints under test. `auth` picks which synthetic identity signs the request —
// the roster/analytics reads want whole-school staff, the class-scoped ones want
// the teacher who actually teaches that class (relationship scoping is real here).
// `workload: true` entries need a seeded roster and are skipped in overhead mode.
const ENDPOINTS = [
  { key: "health", weight: 1, method: "GET", auth: null, path: () => "/health" },
  { key: "analytics", weight: 2, method: "GET", auth: "admin", path: () => "/analytics/overview" },
  { key: "notifications", weight: 3, method: "GET", auth: "teacher", path: () => "/notifications" },
  { key: "classes-mine", weight: 1, method: "GET", auth: "teacher", path: () => "/classes/mine" },
  { key: "students", weight: 1, method: "GET", auth: "admin", path: () => "/students" },
  // --- workload-only reads (over REAL per-tenant data) ---
  {
    key: "register-read",
    weight: 2,
    method: "GET",
    auth: "teacher",
    workload: true,
    path: (s) => `/classes/${pick(s.classIds)}/attendance?date=${today}`,
  },
  // --- the WRITE: take a class register (tx of upserts + an audit_log insert) ---
  // The API enforces "only students actually enrolled in this class may be marked",
  // so the body must use THAT class's roster — hence classStudents, not any student.
  {
    key: "register-write",
    weight: 0, // set from --write-pct at startup
    method: "POST",
    auth: "teacher",
    workload: true,
    write: true,
    path: (s) => `/classes/${s.classIds[0]}/attendance`,
    body: (s) => ({
      date: today,
      // ~10% absent so the guardian-notify branch is exercised realistically.
      records: s.classStudents[s.classIds[0]].map((studentId, i) => ({
        studentId,
        status: i % 10 === 0 ? "ABSENT" : "PRESENT",
      })),
    }),
  },
];

// Tokens: a teacher (class-scoped writes/reads) and a school_admin (whole-school
// roster + analytics). Permissions mirror what those roles really carry.
const TOKENS = {
  teacher: { roles: ["teacher"], permissions: ["notification.read", "class.read", "attendance.read", "attendance.write"] },
  admin: { roles: ["school_admin"], permissions: ["notification.read", "class.read", "attendance.read", "attendance.write"] },
};

const STUDENT_ROLE = "94eb3526-00ac-46c6-b563-10a7f470447d";
const TEACHER_ROLE = "fcc26386-c3dc-4575-a0e2-4c0729e26fde";

function fail(msg) {
  console.error(`\n  ✗ ${msg}\n`);
  process.exit(1);
}
const pick = (arr) => arr[(Math.random() * arr.length) | 0];

function mintToken(userId, schoolId, kind) {
  const { roles, permissions } = TOKENS[kind];
  return jwt.sign({ userId, school_id: schoolId, roles, permissions }, SECRET, {
    algorithm: "HS256",
    expiresIn: "4h",
  });
}

// ---- seeding ----------------------------------------------------------------
async function bulk(db, prefix, rows, chunk = 1000) {
  for (let i = 0; i < rows.length; i += chunk) {
    await db.query(prefix + rows.slice(i, i + chunk).join(","));
  }
}

/**
 * Generate the attendance history INSIDE Postgres (one session per class/day, one
 * record per enrolled student per session). Set-based INSERT…SELECT over
 * generate_series: the row count is students × days — millions at realistic scale —
 * so it must never be materialised in Node.
 *
 * Done in BATCHES OF SCHOOLS, not one statement. A single INSERT…SELECT for the
 * whole run is one enormous transaction: minutes with no progress, WAL blowout,
 * and nothing to show for it if you interrupt (measured: >9min for 6M rows, no
 * visibility). Batching commits incrementally, keeps each transaction small, and
 * prints progress. Scoped strictly to THIS run's schools.
 */
async function seedHistoryInDb(db, schoolIds, batchSize = 100) {
  let sessions = 0;
  let records = 0;
  for (let i = 0; i < schoolIds.length; i += batchSize) {
    const batch = schoolIds.slice(i, i + batchSize);
    const list = batch.map((id) => `'${id}'::uuid`).join(",");
    const s = await db.query(`
      INSERT INTO attendance_session (id, "schoolId", "classId", date, "takenById", "createdAt", "updatedAt")
      SELECT gen_random_uuid(), c."schoolId", c.id, d::date, ct."teacherId", now(), now()
      FROM class c
      JOIN class_teacher ct ON ct."classId" = c.id
      CROSS JOIN generate_series(CURRENT_DATE - ${DAYS}, CURRENT_DATE - 1, interval '1 day') d
      WHERE c."schoolId" IN (${list})
    `);
    const r = await db.query(`
      INSERT INTO attendance_record (id, "schoolId", "sessionId", "studentId", status, "createdAt", "updatedAt")
      SELECT gen_random_uuid(), s."schoolId", s.id, e."studentId",
             (CASE WHEN random() < 0.08 THEN 'ABSENT' ELSE 'PRESENT' END)::"AttendanceStatus", now(), now()
      FROM attendance_session s
      JOIN enrollment e ON e."classId" = s."classId"
      WHERE s."schoolId" IN (${list})
    `);
    sessions += s.rowCount ?? 0;
    records += r.rowCount ?? 0;
    process.stdout.write(`\r  seeding history… ${i + batch.length}/${schoolIds.length} schools, ${records} records`);
  }
  process.stdout.write("\n");
  return { sessions, records };
}

async function seed(db) {
  const schools = [];
  const schoolRows = [];
  const subRows = [];
  const userRows = [];
  const roleRows = [];
  const classRows = [];
  const classTeacherRows = [];
  const enrollRows = [];
  const feeItemRows = [];
  const invoiceRows = [];

  for (let s = 0; s < SCHOOLS; s++) {
    const schoolId = randomUUID();
    const slug = `loadtest-${RUN_ID}-${s}`;
    schoolRows.push(`('${schoolId}','LoadTest ${s}','${slug}',now())`);
    // Plan EXPLICIT: the harness needs the full suite (module-gated endpoints in
    // the mix), and the DB column default is now the fail-closed STANDARD floor.
    subRows.push(`('${randomUUID()}','${schoolId}','ENTERPRISE',now())`);

    if (!WORKLOAD) {
      // Overhead mode: bare users, no roster.
      const tokens = [];
      for (let u = 0; u < USERS; u++) {
        const userId = randomUUID();
        userRows.push(`('${userId}','${schoolId}','lt_${RUN_ID}_${s}_${u}@loadtest.local','LT User','x',now())`);
        tokens.push(mintToken(userId, schoolId, "admin"));
      }
      schools.push({ schoolId, teacherTokens: tokens, adminTokens: tokens, classIds: [], classStudents: {}, studentIds: [] });
      continue;
    }

    // --- WORKLOAD mode: a real school -------------------------------------
    const teacherId = randomUUID();
    const adminId = randomUUID();
    userRows.push(`('${teacherId}','${schoolId}','lt_${RUN_ID}_${s}_t@loadtest.local','LT Teacher','x',now())`);
    userRows.push(`('${adminId}','${schoolId}','lt_${RUN_ID}_${s}_a@loadtest.local','LT Admin','x',now())`);
    roleRows.push(`('${randomUUID()}','${schoolId}','${teacherId}','${TEACHER_ROLE}')`);

    const classIds = [];
    const classStudents = {};
    for (let c = 0; c < CLASSES; c++) {
      const classId = randomUUID();
      classIds.push(classId);
      classStudents[classId] = [];
      classRows.push(`('${classId}','${schoolId}','Class ${c}',now())`);
      classTeacherRows.push(`('${randomUUID()}','${schoolId}','${classId}','${teacherId}')`);
    }

    const studentIds = [];
    for (let st = 0; st < STUDENTS; st++) {
      const studentId = randomUUID();
      studentIds.push(studentId);
      userRows.push(`('${studentId}','${schoolId}','lt_${RUN_ID}_${s}_s${st}@loadtest.local','LT Student ${st}','x',now())`);
      // The student ROLE is what makes the roster query real (listStudents filters on it).
      roleRows.push(`('${randomUUID()}','${schoolId}','${studentId}','${STUDENT_ROLE}')`);
      const classId = classIds[st % CLASSES];
      classStudents[classId].push(studentId);
      enrollRows.push(`('${randomUUID()}','${schoolId}','${classId}','${studentId}')`);
    }

    // NOTE: attendance history is NOT built here — it is generated SERVER-SIDE
    // after this loop (see seedHistoryInDb). At volume it is by far the biggest
    // table (students × days), and materialising tens of millions of row-literals
    // in Node would exhaust the heap long before Postgres broke a sweat.

    // Fees: one fee item + an invoice per student (analytics reads these).
    const feeItemId = randomUUID();
    feeItemRows.push(`('${feeItemId}','${schoolId}','Term Fee',5000000,now())`);
    for (const studentId of studentIds) {
      invoiceRows.push(
        `('${randomUUID()}','${schoolId}','${studentId}','INV-${RUN_ID}-${studentId.slice(0, 8)}',5000000,'${today}','${adminId}','ISSUED',now())`,
      );
    }

    schools.push({
      schoolId,
      teacherTokens: [mintToken(teacherId, schoolId, "teacher")],
      adminTokens: [mintToken(adminId, schoolId, "admin")],
      classIds,
      classStudents,
      studentIds,
    });
  }

  await bulk(db, `INSERT INTO school (id,name,slug,"updatedAt") VALUES `, schoolRows);
  await bulk(db, `INSERT INTO school_subscription (id,"schoolId",plan,"updatedAt") VALUES `, subRows);
  await bulk(db, `INSERT INTO "user" (id,"schoolId",email,name,"passwordHash","updatedAt") VALUES `, userRows);
  if (WORKLOAD) {
    await bulk(db, `INSERT INTO user_role (id,"schoolId","userId","roleId") VALUES `, roleRows);
    await bulk(db, `INSERT INTO class (id,"schoolId",name,"updatedAt") VALUES `, classRows);
    await bulk(db, `INSERT INTO class_teacher (id,"schoolId","classId","teacherId") VALUES `, classTeacherRows);
    await bulk(db, `INSERT INTO enrollment (id,"schoolId","classId","studentId") VALUES `, enrollRows);
    // The big one — generated server-side, in batches (students × days rows).
    const hist = await seedHistoryInDb(db, schools.map((s) => s.schoolId));
    await bulk(db, `INSERT INTO fee_item (id,"schoolId",name,"amountMinor","updatedAt") VALUES `, feeItemRows);
    await bulk(
      db,
      `INSERT INTO invoice (id,"schoolId","studentId",reference,"totalMinor","dueDate","createdById",status,"updatedAt") VALUES `,
      invoiceRows,
    );
    console.log(
      `  seeded workload: ${SCHOOLS} schools × (${STUDENTS} students, ${CLASSES} classes, ${DAYS}d attendance) ` +
        `→ ${userRows.length} users, ${hist.sessions} sessions, ${hist.records} attendance records, ${invoiceRows.length} invoices`,
    );
  }
  return schools;
}

async function cleanup(db) {
  // FK order: children before parents. Everything is keyed to this run's tag, so
  // real tenants are never touched. audit_log/notification rows are produced BY the
  // load itself (writes audit + notify), so they must go too.
  const ids = `(SELECT id FROM school WHERE slug LIKE 'loadtest-${RUN_ID}-%')`;
  for (const sql of [
    `DELETE FROM attendance_record WHERE "schoolId" IN ${ids}`,
    `DELETE FROM attendance_session WHERE "schoolId" IN ${ids}`,
    `DELETE FROM invoice_line_item WHERE "invoiceId" IN (SELECT id FROM invoice WHERE "schoolId" IN ${ids})`,
    `DELETE FROM payment WHERE "invoiceId" IN (SELECT id FROM invoice WHERE "schoolId" IN ${ids})`,
    `DELETE FROM invoice WHERE "schoolId" IN ${ids}`,
    `DELETE FROM fee_item WHERE "schoolId" IN ${ids}`,
    `DELETE FROM enrollment WHERE "schoolId" IN ${ids}`,
    `DELETE FROM class_teacher WHERE "schoolId" IN ${ids}`,
    `DELETE FROM class WHERE "schoolId" IN ${ids}`,
    `DELETE FROM notification WHERE "schoolId" IN ${ids}`,
    `DELETE FROM audit_log WHERE "schoolId" IN ${ids}`,
    `DELETE FROM user_role WHERE "schoolId" IN ${ids}`,
    `DELETE FROM "user" WHERE "schoolId" IN ${ids}`,
    `DELETE FROM school_subscription WHERE "schoolId" IN ${ids}`,
    `DELETE FROM school WHERE slug LIKE 'loadtest-${RUN_ID}-%'`,
  ]) {
    await db.query(sql).catch((e) => console.error(`  ! cleanup step failed: ${e.message}`));
  }
}

// ---- driver -----------------------------------------------------------------
function weightedEndpoints(list) {
  const bag = [];
  for (const e of list) for (let i = 0; i < e.weight; i++) bag.push(e);
  return bag;
}

async function hit(ep, school) {
  const token = ep.auth === "teacher" ? pick(school.teacherTokens) : ep.auth === "admin" ? pick(school.adminTokens) : null;
  const init = { method: ep.method, headers: {} };
  if (token) init.headers.authorization = `Bearer ${token}`;
  if (ep.body) {
    init.headers["content-type"] = "application/json";
    init.body = JSON.stringify(ep.body(school));
  }
  const t0 = performance.now();
  let status = 0;
  try {
    const res = await fetch(API + ep.path(school), init);
    status = res.status;
    await res.arrayBuffer(); // drain so timing includes full transfer
  } catch {
    status = 0; // connection refused / socket error
  }
  return { ms: performance.now() - t0, ok: status >= 200 && status < 400, status };
}

async function warmup(schools) {
  // Drop any endpoint that doesn't return <400, so a route rename or a missing
  // permission never silently turns the baseline into an error-rate measurement.
  const live = [];
  for (const ep of ENDPOINTS) {
    if (ep.workload && !WORKLOAD) continue;
    if (ep.weight === 0) continue;
    const r = await hit(ep, schools[0]);
    if (r.ok) live.push(ep);
    else console.warn(`  ! skipping ${ep.key} — warmup status ${r.status}`);
  }
  if (!live.length) fail("No endpoint passed warmup — is the API running at " + API + "?");
  return live;
}

function pctl(sorted, p) {
  if (!sorted.length) return 0;
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)];
}

async function run(db, schools, endpoints) {
  const stats = new Map(endpoints.map((e) => [e.key, { ms: [], ok: 0, err: 0, write: !!e.write }]));
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
  let writes = 0;
  const rows = [];
  for (const [key, s] of stats) {
    const sorted = [...s.ms].sort((a, b) => a - b);
    const n = s.ok + s.err;
    total += n;
    errors += s.err;
    if (s.write) writes += n;
    rows.push({
      key: s.write ? `${key} (W)` : key,
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
  console.log(`  mode        : ${WORKLOAD ? `WORKLOAD (${STUDENTS} students/school, ${DAYS}d history, ${WRITE_PCT}% writes)` : "OVERHEAD (empty tenants, read-only)"}`);
  console.log(`  config      : ${SCHOOLS} schools, ${CONCURRENCY} concurrent, ${DURATION}s`);
  console.log(`  target      : ${API}`);
  console.log(`  run at      : ${new Date().toISOString()}`);
  console.log("  note        : read routing (replica vs primary) is the API's DATABASE_REPLICA_URL, not the harness's.");
  console.log("-".repeat(72));
  console.log(`  ${"endpoint".padEnd(18)}${"reqs".padStart(8)}${"err%".padStart(7)}${"p50".padStart(8)}${"p95".padStart(8)}${"p99".padStart(8)}  (ms)`);
  for (const r of rows) {
    console.log(
      `  ${r.key.padEnd(18)}${String(r.n).padStart(8)}${r.errPct.toFixed(1).padStart(7)}${f(r.p50)}${f(r.p95)}${f(r.p99)}`,
    );
  }
  console.log("-".repeat(72));
  console.log(`  TOTAL       : ${total} reqs   ${rps.toFixed(0)} req/s   ${((100 * errors) / (total || 1)).toFixed(2)}% errors`);
  if (writes) console.log(`  writes      : ${writes} (${((100 * writes) / total).toFixed(0)}% of traffic)`);
  console.log(`  peak DB connections during run : ${peakConns}`);
  console.log("=".repeat(72) + "\n");
}

// ---- main -------------------------------------------------------------------
(async () => {
  // Turn --write-pct into a weight relative to the read mix.
  if (WRITE_PCT > 0) {
    const readWeight = ENDPOINTS.filter((e) => !e.write && (!e.workload || WORKLOAD)).reduce((a, e) => a + e.weight, 0);
    const w = ENDPOINTS.find((e) => e.write);
    w.weight = Math.max(1, Math.round((readWeight * WRITE_PCT) / (100 - WRITE_PCT)));
  }

  const db = new Client({ connectionString: ADMIN_URL });
  await db.connect().catch((e) => fail(`cannot connect LOADTEST_ADMIN_URL: ${e.message}`));
  let seeded = false;
  try {
    console.log(`\n  seeding ${SCHOOLS} synthetic tenants (run ${RUN_ID}, ${WORKLOAD ? "WORKLOAD" : "overhead"} mode)…`);
    const schools = await seed(db);
    seeded = true;
    console.log("  warming up endpoints…");
    const endpoints = await warmup(schools);
    console.log(`  driving load: ${CONCURRENCY} workers for ${DURATION}s across ${endpoints.length} endpoints…`);
    const result = await run(db, schools, endpoints);
    report(result);
  } finally {
    if (seeded && !KEEP) {
      await cleanup(db);
      console.log("  cleaned up synthetic tenants.");
    } else if (KEEP) {
      console.log(`  --keep: left run ${RUN_ID} in place (slug loadtest-${RUN_ID}-*).`);
    }
    await db.end();
  }
})();
