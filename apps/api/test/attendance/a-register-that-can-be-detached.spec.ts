// =============================================================================
// The biggest table in the product, and the only one with no way out
// =============================================================================
// `attendance_record` was 201 MB and growing at roughly 2.85 M rows per
// 1,000-pupil school over fifteen years — one row per pupil per school day. It
// had NO retention path of any kind, while the yearly SchoolArchive already
// captures attendance: a school archived its register and then kept every row
// for ever anyway.
//
// WHY PARTITION RATHER THAN DELETE, and it is measured rather than argued: this
// repo has already found that VACUUM never shrinks a btree, and that retention
// churn left 1,026 MB of indexes where 534 MB was needed —
// `attendance_record_sessionId_studentId_key` alone went 409 MB -> 8.4 MB on a
// REINDEX. Freeing space by DELETE trades one problem for another. DETACH is
// metadata-only.
//
// Measured on the real stack after the migration: 173,701 rows preserved
// exactly, 201 MB -> 69 MB (the rebuild dropped accumulated bloat), a windowed
// read went from scanning 13 partitions at 1.09 ms to 1 at 0.09 ms, and
// detaching one month released 11,700 rows instantly with the data intact.
// =============================================================================

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const REPO = join(__dirname, "..", "..", "..", "..");
const MIGRATIONS = join(REPO, "packages", "db", "prisma", "migrations");

function migration(fragment: string): string {
  const dir = readdirSync(MIGRATIONS).find((d) => d.includes(fragment));
  expect(dir).toBeDefined();
  return readFileSync(join(MIGRATIONS, dir!, "migration.sql"), "utf8");
}

describe("the partition migration", () => {
  const sql = migration("attendance_record_partition");

  it("takes RLS off the OLD table before copying, or the copy reads nothing", () => {
    // FORCE ROW LEVEL SECURITY applies to the table OWNER too, and the migrate
    // role is not a superuser on RDS — the copy's SELECT would be silently
    // filtered to ZERO rows by a policy whose GUC is unset. Silent data loss.
    const disable = sql.indexOf("DISABLE ROW LEVEL SECURITY");
    const copy = sql.indexOf('INSERT INTO "attendance_record"');
    expect(disable).toBeGreaterThan(-1);
    expect(disable).toBeLessThan(copy);
  });

  it("PROVES the copy before dropping the original", () => {
    const assertAt = sql.indexOf("partition copy mismatch");
    const drop = sql.indexOf('DROP TABLE "attendance_record_old"');
    expect(assertAt).toBeGreaterThan(-1);
    expect(assertAt).toBeLessThan(drop);
  });

  it("takes the date FROM THE SESSION, never invents one", () => {
    expect(sql).toMatch(/JOIN "attendance_session" s ON s\."id" = r\."sessionId"/);
  });

  it("gives every partition its own tenant isolation", () => {
    // A partition is a real table. The parent's policies cover parent-routed
    // queries — all the app ever does — but direct access must still be
    // isolated. Golden Rule #2/#7.
    for (const p of ["_select", "_insert", "_update"]) expect(sql).toContain(`part_name || '${p}'`);
  });

  it("recreates the RLS policies itself rather than trusting the rls/ file", () => {
    // `docker-entrypoint.sh` applies each rls/*.sql keyed on that file's LAST
    // policy as a sentinel — and for 08_attendance_rls.sql the sentinel IS
    // `attendance_record_update`. Without these the file is skipped and the
    // table comes back with no RLS at all.
    for (const p of ["attendance_record_select", "attendance_record_insert", "attendance_record_update"]) {
      expect(sql).toContain(`CREATE POLICY ${p} ON "attendance_record"`);
    }
  });

  it("keeps the register correctable but never deletable", () => {
    expect(sql).toMatch(/GRANT\s+SELECT, INSERT, UPDATE ON "attendance_record" TO major_user/);
    expect(sql).toMatch(/REVOKE DELETE, TRUNCATE\s+ON "attendance_record" FROM major_user/);
  });

  it("has a DEFAULT partition, so a register can never fail to save", () => {
    expect(sql).toContain('CREATE TABLE "attendance_record_default" PARTITION OF "attendance_record" DEFAULT');
  });

  it("introduces NO drop policy, deliberately", () => {
    // How long a school's register is kept is a policy decision with legal
    // weight, not a refactor — the same line the audit_log migration draws.
    // This makes executing that decision instant when it is taken.
    expect(sql).not.toMatch(/DROP TABLE "attendance_record_2/);
    expect(sql).not.toMatch(/DETACH PARTITION/);
  });
});

describe("the write path", () => {
  const src = readFileSync(join(__dirname, "..", "..", "src", "attendance", "attendance.service.ts"), "utf8");

  it("supplies the partition key from the session's own date", () => {
    // Not from `new Date()`, and not from the caller separately: the same
    // `date` the session was just upserted on. A record can then never land in
    // a partition its register does not belong to.
    expect(src).toMatch(/\$\{date\}::date/);
    expect(src).toMatch(/ON CONFLICT \("sessionId", "studentId", "date"\)/);
  });

  it("filters a windowed read on the record's OWN date, so Postgres can prune", () => {
    // Through the session join it scanned every partition — 13 at 1.09 ms
    // against 1 at 0.09 ms — and that degrades with the school's age.
    expect(src).toMatch(/date: \{ \.\.\.\(window\.from \? \{ gte: window\.from \} : \{\}\)/);
  });
});

describe("the provisioning job", () => {
  const src = readFileSync(join(__dirname, "..", "..", "src", "maintenance", "audit-partition.service.ts"), "utf8");

  it("provisions attendance as well as the audit log", () => {
    // A school marks attendance every working morning; its partitions have to
    // exist before the register is taken.
    expect(src).toContain("ensure_attendance_record_partition");
    expect(src).toContain("ensure_audit_log_partition");
  });

  it("counts BOTH default partitions into the one number the console reads", () => {
    expect(src).toMatch(/defaultRows \+= n/);
  });
});
