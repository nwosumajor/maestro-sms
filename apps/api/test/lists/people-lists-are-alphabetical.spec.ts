// =============================================================================
// Finding one person among all of them
// =============================================================================
// Three separate reasons a list of people came back in an order nobody could
// scan. Found by asking the running system for each list and checking whether
// what came back was sorted:
//
//   students             n=500  alphabetical=true
//   hr employees         n=14   alphabetical=false   <- ordered by hire date
//   users (roles page)   n=500  alphabetical=false   <- byte order, see below
//   class roster         n=30   alphabetical=false   <- no orderBy at all
//
// 1. THE STAFF REGISTER WAS ORDERED BY HIRE DATE. `orderBy: { createdAt:
//    "desc" }` — the order a register is BUILT in, not the order it is read in.
//
// 2. THE CLASS ROSTER HAD NO ORDER AT ALL. Thirty pupils in whatever order the
//    rows sat in. This is the list a teacher scans to find one pupil, and the
//    same query feeds the daily register (`TakeRegister` reads `/classes/:id`).
//
// 3. EVERY `ORDER BY name` SORTED BY BYTE VALUE. `SELECT 'apple' < 'Zebra'`
//    answered false, so all uppercase sorted before all lowercase and accented
//    names landed at the end. `datcollate` says `en_US.utf8`; the Postgres image
//    is Alpine, musl has no real locale support, and glibc locale names degrade
//    silently to C. Fixed at the COLUMN with an ICU collation, so Prisma's
//    `orderBy: { name: "asc" }` — which cannot express COLLATE — is correct
//    everywhere at once. See `20261223000000_name_icu_collation`.
// =============================================================================

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { HrService } from "../../src/hr/hr.service";
import { LmsService } from "../../src/lms/lms.service";
import type { Principal, TenantContext, TenantTx } from "../../src/integrity/integrity.foundation";

const p: Principal = {
  schoolId: "S",
  userId: "u-hr",
  roles: ["hr_manager"],
  permissions: ["hr.read", "class.read"],
};

/** Deliberately NOT alphabetical, and deliberately not reverse either — an
 *  order that only looks sorted if the code happens to preserve insertion. */
const STAFF = [
  { userId: "u-3", name: "Zainab Bello" },
  { userId: "u-1", name: "amina yusuf" }, // lowercase: byte order puts this last
  { userId: "u-2", name: "Chidi Okafor" },
  { userId: "u-4", name: "Ébò Adé" }, // accented: byte order puts this last too
];

describe("the staff register", () => {
  function makeHr() {
    const tx = {
      employee: { findMany: jest.fn(async () => STAFF.map((s) => ({ userId: s.userId, id: s.userId }))) },
      // The caller is the CLASS TEACHER of this class — what the retired join
      // row used to say, now read off `class.supervisorId`.
      class: {
        findFirst: jest.fn().mockResolvedValue({ id: "c-1", name: "JSS2A" }),
        findMany: jest.fn().mockResolvedValue([{ id: "c-1" }]),
      },
      classSubjectTeacher: { findMany: jest.fn().mockResolvedValue([]) },
      user: {
        findMany: jest.fn(async () => STAFF.map((s) => ({ id: s.userId, name: s.name, email: null }))),
      },
    } as unknown as TenantTx;
    const db = { runAsTenant: <T>(_c: TenantContext, fn: (t: TenantTx) => Promise<T>) => fn(tx) };
    return new HrService(db as never, { record: jest.fn() } as never);
  }

  it("is ordered by name, not by when each person was hired", async () => {
    const svc = makeHr();
    const rows = (await svc.listEmployees(p)) as Array<{ user: { name: string } | null }>;
    const names = rows.map((r) => r.user?.name ?? "");
    expect(names).toEqual([...names].sort((a, b) => a.localeCompare(b)));
  });

  it("does not put every lowercase or accented name last", async () => {
    // What byte order does, and what a school with real surnames actually has.
    const svc = makeHr();
    const rows = (await svc.listEmployees(p)) as Array<{ user: { name: string } | null }>;
    const names = rows.map((r) => r.user?.name ?? "");
    expect(names[0]).toBe("amina yusuf");
    expect(names[names.length - 1]).toBe("Zainab Bello");
  });

  it("still returns every employee", async () => {
    const svc = makeHr();
    const rows = await svc.listEmployees(p);
    expect(rows).toHaveLength(STAFF.length);
  });

  it("does not fall over when a staff account has no user row", async () => {
    // The register flags accounts awaiting an employment record; the reverse
    // can happen too, and a comparator that assumes a name would throw.
    const tx = {
      employee: { findMany: jest.fn(async () => [{ userId: "gone", id: "gone" }, { userId: "u-2", id: "u-2" }]) },
      user: { findMany: jest.fn(async () => [{ id: "u-2", name: "Chidi Okafor", email: null }]) },
    } as unknown as TenantTx;
    const db = { runAsTenant: <T>(_c: TenantContext, fn: (t: TenantTx) => Promise<T>) => fn(tx) };
    const svc = new HrService(db as never, { record: jest.fn() } as never);
    await expect(svc.listEmployees(p)).resolves.toHaveLength(2);
  });
});

describe("the class roster", () => {
  it("asks the database for pupils in name order", async () => {
    // Asserted on the QUERY rather than the result, because the ordering has to
    // happen in the database: this list is what the daily register renders, and
    // sorting a page after it has been cut is the wrong page sorted.
    let enrolmentArgs: { orderBy?: unknown } = {};
    let teacherArgs: { orderBy?: unknown } = {};
    const tx = {
      // The caller is the CLASS TEACHER of c-1 — the relationship the retired
      // join row carried, now `class.supervisorId`.
      class: {
        findFirst: jest.fn(async () => ({ id: "c-1", name: "SS2 C", schoolId: "S" })),
        findMany: jest.fn().mockResolvedValue([{ id: "c-1" }]),
      },
      classSubjectTeacher: { findFirst: jest.fn(async () => null), findMany: jest.fn().mockResolvedValue([]) },
      enrollment: {
        findMany: jest.fn(async (a: { orderBy?: unknown }) => {
          enrolmentArgs = a;
          return [];
        }),
      },
      auditLog: { create: jest.fn(async () => ({})) },
    } as unknown as TenantTx;
    const db = {
      runAsTenant: <T>(_c: TenantContext, fn: (t: TenantTx) => Promise<T>) => fn(tx),
      runAsTenantReadOnly: <T>(_c: TenantContext, fn: (t: TenantTx) => Promise<T>) => fn(tx),
    };
    const svc = new LmsService(db as never, { record: jest.fn() } as never);
    await svc.getClassRoster({ ...p, roles: ["school_admin"], permissions: ["class.read"] }, "c-1");

    expect(enrolmentArgs.orderBy).toEqual({ student: { name: "asc" } });
    // The class teacher is a single column on the class now, so there is no
    // list of teachers to order — one fewer query, and nothing to sort.

  });
});

describe("the collation the whole application sorts under", () => {
  const MIGRATIONS = join(__dirname, "../../../../packages/db/prisma/migrations");

  function migration(): string {
    const dir = readdirSync(MIGRATIONS).find((d) => d.endsWith("_name_icu_collation"));
    expect(dir).toBeDefined();
    return readFileSync(join(MIGRATIONS, dir as string, "migration.sql"), "utf8");
  }

  it("puts the person name column on an ICU collation", () => {
    // Without this every `orderBy: { name: "asc" }` in the codebase — and there
    // are dozens — sorts by byte value on an Alpine image.
    expect(migration()).toMatch(/ALTER TABLE "user" ALTER COLUMN "name" TYPE text COLLATE "und-x-icu"/);
  });

  it("covers the other names that are read as an alphabetical list", () => {
    const sql = migration();
    for (const t of ["class", "subject"]) {
      expect([t, /COLLATE "und-x-icu"/.test(sql) && sql.includes(`ALTER TABLE "${t}"`)]).toEqual([t, true]);
    }
  });

  it("uses a DETERMINISTIC collation", () => {
    // A nondeterministic one would give case-insensitive EQUALITY as well, which
    // silently changes unique constraints, joins and LIKE. `und-x-icu` is
    // deterministic: comparison order changes, equality does not.
    expect(migration()).toMatch(/DETERMINISTIC|deterministic/);
  });
});
