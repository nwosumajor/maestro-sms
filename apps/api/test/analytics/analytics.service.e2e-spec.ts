// =============================================================================
// AnalyticsService.overview — grade-band aggregate integration (real DB)
// =============================================================================
// The grade-distribution stat moved from "pull every published grade into
// Node and bucket in JS" to a single Postgres aggregate (FILTER/AVG over a
// derived pct column). A unit test with a mocked $queryRaw can't prove the SQL
// arithmetic is right — only a real Postgres run can, so this seeds grades
// spanning every band (including a DRAFT row that must be excluded and a
// zero-maxScore row that must fall back to 0%, matching the old JS behaviour
// exactly) and hand-verifies the aggregate against arithmetic worked out by
// hand. Also proves the family-scoped (parent) branch joins through
// submission.studentId correctly and never sees another child's grades.
//
// The FEES block got the same push-down (SUMs over billable invoices + POSTED
// payments in one statement), so this suite also seeds invoices spanning every
// status filter (DRAFT + CANCELLED excluded, a PENDING_APPROVAL payment that
// must not count, a REFUND that subtracts) and asserts the aggregate for both
// the school-wide and family-scoped branches.
//
// Needs TEST_DATABASE_URL (app role; also DATABASE_URL for the Prisma
// singleton) + TEST_ADMIN_URL (superuser, to seed). Skips otherwise.
// =============================================================================

import { Pool } from "pg";
import { randomUUID } from "node:crypto";
import { AnalyticsService } from "../../src/analytics/analytics.service";
import { PrismaTenantService } from "../../src/foundation/prisma-tenant.service";
import type { Principal } from "../../src/integrity/integrity.foundation";

const APP_URL = process.env.TEST_DATABASE_URL;
const ADMIN_URL = process.env.TEST_ADMIN_URL;
const d = APP_URL && ADMIN_URL ? describe : describe.skip;

d("AnalyticsService.overview grade-band aggregate (real Postgres)", () => {
  let admin: Pool;
  let svc: AnalyticsService;

  const SA = randomUUID();
  const STAFF = randomUUID();
  const PARENT = randomUUID();
  const S1 = randomUUID(); // the parent's own child — 2 grades (A, C)
  const S2 = randomUUID(); // a different student — the parent must never see this one

  // Assessment/submission/grade ids, one triple per grade row.
  const rows = [
    { student: S1, score: 90, max: 100, status: "PUBLISHED" }, // 90% -> A
    { student: S1, score: 55, max: 100, status: "PUBLISHED" }, // 55% -> C
    { student: S2, score: 65, max: 100, status: "PUBLISHED" }, // 65% -> B
    { student: S2, score: 47, max: 100, status: "PUBLISHED" }, // 47% -> D
    { student: S2, score: 30, max: 100, status: "PUBLISHED" }, // 30% -> F
    { student: S2, score: 0, max: 0, status: "PUBLISHED" }, // maxScore 0 -> COALESCE to 0% -> F
    { student: S2, score: 100, max: 100, status: "DRAFT" }, // DRAFT -> excluded entirely
  ];

  // Invoices: reference -> {student, totalMinor, status, posted payments}.
  // DRAFT + CANCELLED are excluded from the aggregate entirely; the
  // PENDING_APPROVAL payment must never count; the REFUND subtracts.
  const invoices = [
    { ref: "INV-1", student: S1, total: 50_000, status: "ISSUED" }, // payments: +20k POSTED, -5k REFUND, 7,777 PENDING_APPROVAL
    { ref: "INV-2", student: S2, total: 30_000, status: "PAID" }, // payment: +30k POSTED
    { ref: "INV-3", student: S2, total: 999_999, status: "DRAFT" }, // excluded
    { ref: "INV-4", student: S1, total: 888_888, status: "CANCELLED" }, // excluded
  ];

  const perms = ["grade.read", "fee.read"];
  const staff = (): Principal => ({ userId: STAFF, schoolId: SA, roles: ["principal"], permissions: perms });
  const parent = (): Principal => ({ userId: PARENT, schoolId: SA, roles: ["parent"], permissions: perms });

  beforeAll(async () => {
    admin = new Pool({ connectionString: ADMIN_URL });
    await admin.query(`INSERT INTO school (id,name,slug,"updatedAt") VALUES ($1,'AN',$2,now())`, [SA, "an-" + SA]);
    for (const [u, name] of [[STAFF, "Principal"], [PARENT, "Parent"], [S1, "Child One"], [S2, "Child Two"]] as const) {
      await admin.query(
        `INSERT INTO "user" (id,"schoolId",email,name,"passwordHash","updatedAt") VALUES ($1,$2,$3,$4,'x',now())`,
        [u, SA, u + "@an", name],
      );
    }
    await admin.query(
      `INSERT INTO parent_child (id,"schoolId","parentId","studentId") VALUES ($1,$2,$3,$4)`,
      [randomUUID(), SA, PARENT, S1],
    );
    for (const r of rows) {
      const assessmentId = randomUUID();
      const submissionId = randomUUID();
      await admin.query(
        `INSERT INTO assessment (id,"schoolId",title,"createdById","updatedAt") VALUES ($1,$2,'T',$3,now())`,
        [assessmentId, SA, STAFF],
      );
      await admin.query(
        `INSERT INTO submission (id,"schoolId","assessmentId","studentId","updatedAt") VALUES ($1,$2,$3,$4,now())`,
        [submissionId, SA, assessmentId, r.student],
      );
      await admin.query(
        `INSERT INTO grade (id,"schoolId","submissionId",score,"maxScore",status,"gradedById","updatedAt")
         VALUES ($1,$2,$3,$4,$5,$6,$7,now())`,
        [randomUUID(), SA, submissionId, r.score, r.max, r.status, STAFF],
      );
    }
    const invoiceIds: Record<string, string> = {};
    for (const inv of invoices) {
      invoiceIds[inv.ref] = randomUUID();
      await admin.query(
        `INSERT INTO invoice (id,"schoolId","studentId",reference,status,"totalMinor","dueDate","createdById","updatedAt")
         VALUES ($1,$2,$3,$4,$5,$6,now(),$7,now())`,
        [invoiceIds[inv.ref], SA, inv.student, inv.ref, inv.status, inv.total, STAFF],
      );
    }
    const payments = [
      { inv: "INV-1", amount: 20_000, kind: "PAYMENT", status: "POSTED" },
      { inv: "INV-1", amount: 5_000, kind: "REFUND", status: "POSTED" },
      { inv: "INV-1", amount: 7_777, kind: "PAYMENT", status: "PENDING_APPROVAL" }, // must not count
      { inv: "INV-2", amount: 30_000, kind: "PAYMENT", status: "POSTED" },
    ];
    for (const pay of payments) {
      await admin.query(
        `INSERT INTO payment (id,"schoolId","invoiceId","amountMinor",method,kind,status,"recordedById")
         VALUES ($1,$2,$3,$4,'CASH',$5,$6,$7)`,
        [randomUUID(), SA, invoiceIds[pay.inv], pay.amount, pay.kind, pay.status, STAFF],
      );
    }

    const tenant = new PrismaTenantService() as never;
    svc = new AnalyticsService(tenant);
  });

  afterAll(async () => {
    for (const t of ["payment", "invoice", "grade", "submission", "assessment", "parent_child"]) {
      await admin.query(`DELETE FROM ${t} WHERE "schoolId" = $1`, [SA]);
    }
    await admin.query(`DELETE FROM "user" WHERE "schoolId" = $1`, [SA]);
    await admin.query(`DELETE FROM school WHERE id = $1`, [SA]);
    await admin.end();
  });

  it("school-wide (staff): buckets every PUBLISHED grade into the right band, excludes DRAFT, folds maxScore=0 into 0%/F", async () => {
    const out = await svc.overview(staff());
    // PUBLISHED only: 90(A) 55(C) 65(B) 47(D) 30(F) 0/0->0%(F) = 6 rows; the DRAFT 100/100 is excluded.
    expect(out.grades).toEqual({ A: 1, B: 1, C: 1, D: 1, F: 2, graded: 6, averagePct: 48 }); // (90+55+65+47+30+0)/6 = 47.83 -> 48
  });

  it("family-scoped (parent): sees only their own child's grades, joined through submission.studentId", async () => {
    const out = await svc.overview(parent());
    // Only S1's two PUBLISHED grades: 90% (A) and 55% (C).
    expect(out.grades).toEqual({ A: 1, B: 0, C: 1, D: 0, F: 0, graded: 2, averagePct: 73 }); // (90+55)/2 = 72.5 -> 73 (banker's/half-up via SQL ROUND)
  });

  it("fees school-wide (staff): sums billable invoices + POSTED payments only; DRAFT/CANCELLED/PENDING_APPROVAL excluded, REFUND subtracts", async () => {
    const out = await svc.overview(staff());
    // Billable: INV-1 (50k) + INV-2 (30k). Collected: 20k - 5k refund + 30k = 45k.
    expect(out.fees).toEqual({ invoicedMinor: 80_000, collectedMinor: 45_000, outstandingMinor: 35_000, invoices: 2 });
  });

  it("fees family-scoped (parent): only their own child's invoices", async () => {
    const out = await svc.overview(parent());
    // S1 only: INV-1 (50k billable; CANCELLED INV-4 excluded). Collected: 20k - 5k.
    expect(out.fees).toEqual({ invoicedMinor: 50_000, collectedMinor: 15_000, outstandingMinor: 35_000, invoices: 1 });
  });
});
