// =============================================================================
// PROBE: two approvers, one class, the same free places
// =============================================================================
// `StudentImportService.approve` reads each class's remaining places in PHASE 2
// — a read-only transaction — and decides row-by-row against that map. The
// enrolments are written later, in PHASE 3c, a DIFFERENT transaction.
//
// A snapshot is not a reservation. Two approvers clearing the review queue at
// the same moment each read the same headroom, each batch individually fits,
// and both write. The class ends up over its capacity with nothing in the log
// to say how — and the sign-in slips for the extra children have already been
// shown, once, on a response nobody can get back.
//
// The fix is not a better pre-check: no pre-check in an earlier transaction can
// beat a concurrent approver. It is to re-assert inside the WRITE, where the
// class row can actually be locked.
//
// Run: `pnpm --filter @sms/api test:db -- two-batches-for-the-last-places`.
// =============================================================================

import { Pool } from "pg";
import { randomUUID } from "node:crypto";
import { prisma } from "@sms/db";
import { StudentImportService } from "../../src/admin/student-import.service";
import { PrismaTenantService } from "../../src/foundation/prisma-tenant.service";
import { AuditLogService } from "../../src/foundation/audit-log.service";
import type { Principal } from "../../src/integrity/integrity.foundation";

const APP_URL = process.env.TEST_DATABASE_URL;
const ADMIN_URL = process.env.TEST_ADMIN_URL;
const d = APP_URL && ADMIN_URL ? describe : describe.skip;

d("two import batches for the last places (real Postgres)", () => {
  let admin: Pool;
  let svc: StudentImportService;

  const SCHOOL = randomUUID();
  const APPROVER_A = randomUUID();
  const APPROVER_B = randomUUID();
  // A THIRD person uploads both batches. Maker-checker refuses your own upload,
  // so uploading them as APPROVER_A made one approval fail for that reason and
  // the probe never raced anything — it passed with the guard removed.
  const UPLOADER = randomUUID();
  const CLASS = randomUUID();
  const BATCH_A = randomUUID();
  const BATCH_B = randomUUID();
  const CAPACITY = 4;
  const PER_BATCH = 3; // each batch fits alone; together they do not

  const approver = (id: string): Principal => ({
    userId: id,
    schoolId: SCHOOL,
    roles: ["school_admin"],
    permissions: ["student.import.review", "class.write"],
  });

  // Names that cannot collide ACROSS the two batches. Sign-in identifiers are
  // generated from the name, and a collision raises P2002 — which refuses the
  // second batch for a reason that is not capacity, so the probe passes with
  // the guard removed and measures nothing.
  const rows = (tag: string) =>
    Array.from({ length: PER_BATCH }, (_, i) => ({
      name: `${tag}forename${i} ${tag}surname${i}`,
      // SUPPLIED, and distinct per batch. Admission numbers are ALLOCATED from
      // a set read in each approval's own read-only transaction, so two
      // concurrent batches allocate the same sequence and the second dies on
      // P2002 — deliberate, documented, and a refusal that is not about
      // capacity. Left to allocate, it fires first every time and this probe
      // measures the wrong guard.
      admissionNumber: `${tag}-ADM-${i + 1}`,
      classId: CLASS,
    }));

  beforeAll(async () => {
    admin = new Pool({ connectionString: ADMIN_URL });
    await admin.query(`INSERT INTO school (id,name,slug,currency,"updatedAt") VALUES ($1,'Cap',$2,'NGN',now())`, [
      SCHOOL,
      "cap-" + SCHOOL,
    ]);
    for (const [id, n] of [[APPROVER_A, "Head"], [APPROVER_B, "Deputy"], [UPLOADER, "Registrar"]] as const) {
      await admin.query(
        `INSERT INTO "user" (id,"schoolId",email,name,"passwordHash","updatedAt") VALUES ($1,$2,$3,$4,'x',now())`,
        [id, SCHOOL, `${id}@cap.test`, n],
      );
    }
    await admin.query(
      `INSERT INTO "class" (id,"schoolId",name,capacity,"updatedAt") VALUES ($1,$2,'JSS 1A',$3,now())`,
      [CLASS, SCHOOL, CAPACITY],
    );
    for (const [id, tag] of [[BATCH_A, "A"], [BATCH_B, "B"]] as const) {
      await admin.query(
        `INSERT INTO student_import_batch (id,"schoolId","uploadedById",rows,status,"createdAt","updatedAt")
         VALUES ($1,$2,$3,$4::jsonb,'PENDING',now(),now())`,
        [id, SCHOOL, UPLOADER, JSON.stringify(rows(tag))],
      );
    }
    svc = new StudentImportService(new PrismaTenantService() as never, new AuditLogService());
  });

  afterAll(async () => {
    // Children before parents: enrolments and roles reference users and classes.
    for (const t of [
      "enrollment",
      "student_profile",
      "user_role",
      "student_import_batch",
      "audit_log",
      '"class"',
      '"user"',
      "school",
    ]) {
      await admin.query(`DELETE FROM ${t} WHERE "schoolId" = $1`, [SCHOOL]).catch(async () => {
        await admin.query(`DELETE FROM ${t} WHERE id = $1`, [SCHOOL]).catch(() => undefined);
      });
    }
    await admin.end();
    await prisma.$disconnect();
  });

  it("cannot put six pupils in a class of four", async () => {
    // Promise.all, not a loop: a sequential run is the test that PASSES against
    // this defect, because the second approver correctly sees the first's rows.
    const out = await Promise.allSettled([
      svc.approve(approver(APPROVER_A), BATCH_A),
      svc.approve(approver(APPROVER_B), BATCH_B),
    ]);

    const seated = await admin.query(
      `SELECT count(*)::int AS n FROM enrollment WHERE "classId" = $1 AND status = 'ACTIVE'`,
      [CLASS],
    );
    const ok = out.filter((r) => r.status === "fulfilled").length;
    for (const r of out) {
      // eslint-disable-next-line no-console -- why a batch was refused is the measurement
      if (r.status === "rejected") console.log(`  refused: ${String((r.reason as Error).message).slice(0, 120)}`);
      else console.log(`  through: ${JSON.stringify(r.value).slice(0, 160)}`);
    }
    // eslint-disable-next-line no-console -- the measurement is the point
    console.log(`  approved=${ok} active=${seated.rows[0].n} capacity=${CAPACITY}`);

    // The rule, stated as the room: a class never holds more children than it
    // has places, however many people press approve at once.
    expect(seated.rows[0].n).toBeLessThanOrEqual(CAPACITY);
    // And one of them must have got through — a guard that refuses BOTH has
    // turned a race into an outage.
    expect(ok).toBeGreaterThanOrEqual(1);
  });
});
