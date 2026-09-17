// =============================================================================
// The import that could only ever be done once
// =============================================================================
// A row matching a pupil already on roll was counted as a "duplicate" and
// dropped. So the file was a one-shot: a school that mistyped a column, or that
// imported before it had gathered addresses, had no bulk route back — the only
// way to correct its own roll was one pupil at a time, on the record of every
// child in the school, for ever. The export beside it was `#, Name, Class,
// Status`, four display columns no path could read, so there was no round trip
// either.
//
// Making it an upsert is only safe because of ONE rule, and it is the rule this
// suite exists for:
//
//   A BLANK CELL NEVER CLEARS A STORED VALUE.
//
// A school re-uploading its roll with only the address columns filled in must
// not wipe every date of birth it loaded last term. The other reading destroys
// data nobody asked to destroy, and nothing would report it — a cleared field
// looks exactly like one that was never supplied.
//
// And an update rewrites a child's record, so it goes through the SAME
// maker-checker approval a creation does, with the changed FIELDS shown to the
// approver. A count alone asks somebody to sign for something they cannot see.
// =============================================================================

import { StudentImportService } from "../../src/admin/student-import.service";
import type { Principal, TenantContext, TenantTx } from "../../src/integrity/integrity.foundation";

jest.setTimeout(60_000);

type Row = Record<string, unknown>;

const ADA = {
  id: "pf-ada",
  studentId: "u-ada",
  admissionNumber: "ADM-001",
  dateOfBirth: new Date("2012-05-01"),
  gender: "F",
  phone: "08000000000",
  addressLine1: "12 Main St",
  addressLine2: null,
  city: null,
  state: null,
  student: { name: "Ada Lovelace" },
};

function makeService(opts: { onRoll?: (typeof ADA)[]; batch?: Row | null } = {}) {
  const onRoll = opts.onRoll ?? [ADA];
  const state: { batch: Row | null } = { batch: opts.batch ?? null };
  const rawSql: { sql: string; values: unknown[] }[] = [];
  const created: Row[] = [];

  const tx = {
    user: {
      findMany: jest.fn().mockResolvedValue([]),
      createMany: jest.fn((a: { data: Row[] }) => { created.push(...a.data); return Promise.resolve({ count: a.data.length }); }),
    },
    userRole: { createMany: jest.fn(async (a: { data: Row[] }) => ({ count: a.data.length })) },
    studentProfile: {
      // HONOURS `where.admissionNumber.in`. The service asks this for two
      // different questions — every number in use, and the rows this file would
      // UPDATE — and a stub returning the same list for both would let the
      // update path disappear with every assertion still green.
      findMany: jest.fn((a?: { where?: { admissionNumber?: { in?: string[]; not?: unknown } } }) => {
        const want = a?.where?.admissionNumber?.in;
        const rows = want ? onRoll.filter((r) => want.includes(r.admissionNumber)) : onRoll;
        return Promise.resolve(rows);
      }),
      createMany: jest.fn(async (a: { data: Row[] }) => ({ count: a.data.length })),
    },
    enrollment: { createMany: jest.fn(async (a: { data: Row[] }) => ({ count: a.data.length })), groupBy: jest.fn().mockResolvedValue([]) },
    class: { findMany: jest.fn().mockResolvedValue([]), findFirst: jest.fn().mockResolvedValue(null) },
    role: { findFirst: jest.fn().mockResolvedValue({ id: "student-role" }) },
    school: { findFirst: jest.fn().mockResolvedValue({ slug: "demo" }) },
    // The bulk UPDATE. Captured as SQL + bound values so the test can assert
    // the SEMANTIC (COALESCE) and the payload, not merely that a call happened.
    $executeRaw: jest.fn((q: TemplateStringsArray, ...rest: unknown[]) => {
      // `$executeRaw` is a TAGGED TEMPLATE, so the first argument IS the
      // TemplateStringsArray. Reading `q.values` off it returns
      // `Array.prototype.values` — a FUNCTION, not the bound parameters — which
      // is a double that vouches for anything. (Written that way first, which is
      // how this comment comes to be here.) The bound values are the rest args,
      // and any `Prisma.sql` fragment among them — the VALUES list is one —
      // carries its own, so they are flattened out.
      const sql = Array.from(q).join(" ");
      const flat: unknown[] = [];
      const walk = (v: unknown) => {
        const frag = v as { values?: unknown[]; strings?: string[] } | null;
        if (frag && Array.isArray(frag.values) && Array.isArray(frag.strings)) frag.values.forEach(walk);
        else flat.push(v);
      };
      rest.forEach(walk);
      rawSql.push({ sql, values: flat });
      return Promise.resolve(1);
    }),
    studentImportBatch: {
      create: jest.fn((a: { data: Row }) => Promise.resolve({ id: "b1", ...a.data })),
      findFirst: jest.fn(() => Promise.resolve(state.batch)),
      update: jest.fn((a: { data: Row }) => { state.batch = { ...(state.batch ?? {}), ...a.data }; return Promise.resolve(state.batch); }),
      updateMany: jest.fn(() => Promise.resolve({ count: (state.batch as { status?: string } | null)?.status === "PENDING" ? 1 : 0 })),
    },
  } as unknown as TenantTx;

  const db = {
    runAsTenant: <T,>(_c: TenantContext, fn: (t: TenantTx) => Promise<T>) => fn(tx),
    runAsTenantReadOnly: <T,>(_c: TenantContext, fn: (t: TenantTx) => Promise<T>) => fn(tx),
  };
  const service = new StudentImportService(db as never, { record: jest.fn() } as never);
  return { service, tx, rawSql, created, state };
}

const p = (userId: string): Principal => ({ schoolId: "A", userId, roles: ["school_admin"], permissions: ["student.import"] });

describe("the dry run tells an approver what would CHANGE", () => {
  it("counts a matching row as an update, not as a NEW pupil", async () => {
    // The file names one pupil and that pupil is already on roll, so nothing is
    // new. Before this the row was a "duplicate" and was dropped in silence.
    const { service, tx } = makeService();
    await service.stage(p("uploader"), [
      { name: "Ada Lovelace", admissionNumber: "ADM-001", city: "Lagos", state: "Lagos" },
    ]);
    const staged = (tx.studentImportBatch.create as jest.Mock).mock.calls[0][0].data;
    expect(staged.summary).toMatchObject({ total: 1, newCount: 0, updateCount: 1 });
  });

  it("names the FIELDS, the pupil and the before/after", async () => {
    const { service, tx } = makeService();
    await service.stage(p("uploader"), [
      { name: "Ada Lovelace", admissionNumber: "ADM-001", city: "Lagos", state: "Lagos" },
    ]);
    const staged = (tx.studentImportBatch.create as jest.Mock).mock.calls[0][0].data;
    const summary = staged.summary as { updateCount?: number; updates?: { changes: { field: string; from: string | null; to: string | null }[] }[] };
    expect(summary.updateCount).toBe(1);
    expect(summary.updates?.[0].changes).toEqual(
      expect.arrayContaining([
        { field: "city", from: null, to: "Lagos" },
        { field: "state", from: null, to: "Lagos" },
      ]),
    );
  });

  it("does NOT count a field the file repeats unchanged", async () => {
    // Otherwise every re-upload reads as if it would rewrite the whole school,
    // and a reviewer learns to approve without looking.
    const { service, tx } = makeService();
    await service.stage(p("uploader"), [
      { name: "Ada Lovelace", admissionNumber: "ADM-001", gender: "F", phone: "08000000000" },
    ]);
    const staged = (tx.studentImportBatch.create as jest.Mock).mock.calls[0][0].data;
    expect((staged.summary as { updateCount?: number }).updateCount).toBeUndefined();
  });

  it("caps the preview but not the COUNT", async () => {
    const many = Array.from({ length: 40 }, (_, i) => ({
      ...ADA,
      id: `pf-${i}`,
      studentId: `u-${i}`,
      admissionNumber: `ADM-${100 + i}`,
      student: { name: `Pupil ${i}` },
    }));
    const { service, tx } = makeService({ onRoll: many });
    await service.stage(
      p("uploader"),
      many.map((m) => ({ name: m.student.name, admissionNumber: m.admissionNumber, city: "Lagos" })),
    );
    const staged = (tx.studentImportBatch.create as jest.Mock).mock.calls[0][0].data;
    const summary = staged.summary as { updateCount?: number; updates?: unknown[] };
    expect(summary.updateCount).toBe(40);
    expect(summary.updates?.length).toBe(25);
  });
});

describe("a blank cell never clears a stored value", () => {
  it("writes COALESCE(new, old) rather than the row as given", async () => {
    // The whole safety of the upsert, asserted on the STATEMENT. A test that
    // only checked the bound values would pass against an UPDATE that sets
    // every column to the row's nulls.
    const { service, rawSql } = makeService({
      batch: { id: "b1", status: "PENDING", uploadedById: "uploader", rows: [
        { name: "Ada Lovelace", admissionNumber: "ADM-001", city: "Lagos" },
      ] },
    });
    await service.approve(p("approver"), "b1");
    const update = rawSql.find((r) => /UPDATE student_profile/.test(r.sql));
    expect(update).toBeDefined();
    for (const col of ["dateOfBirth", "gender", "phone", "addressLine1", "addressLine2", "city", "state"]) {
      // Plain substring, not a regex built from the column name — escaping one
      // into a pattern is how an assertion comes to test its own regex.
      const coalesced =
        update!.sql.includes('COALESCE(v."' + col + '"') || update!.sql.includes("COALESCE(v." + col);
      expect({ col, coalesced }).toEqual({ col, coalesced: true });
    }
  });

  it("binds NULL for a column the file left blank, so COALESCE keeps the old one", async () => {
    const { service, rawSql } = makeService({
      batch: { id: "b1", status: "PENDING", uploadedById: "uploader", rows: [
        { name: "Ada Lovelace", admissionNumber: "ADM-001", city: "Lagos" },
      ] },
    });
    await service.approve(p("approver"), "b1");
    const update = rawSql.find((r) => /UPDATE student_profile/.test(r.sql))!;
    // The row supplied only `city`; everything else must arrive as null.
    expect(update.values).toContain("Lagos");
    expect(update.values.filter((v) => v === null).length).toBeGreaterThanOrEqual(5);
  });

  it("creates NO account and NO password for a row that is an update", async () => {
    // bcrypt is the dominant cost of an import — roughly 100 ms a row — and an
    // update needs no account at all. Hashing first and discovering afterwards
    // would burn a minute and a half of CPU on a 1,000-pupil correction that
    // creates nobody, every time a school made one.
    const { service, created, tx } = makeService({
      batch: { id: "b1", status: "PENDING", uploadedById: "uploader", rows: [
        { name: "Ada Lovelace", admissionNumber: "ADM-001", city: "Lagos" },
      ] },
    });
    const out = await service.approve(p("approver"), "b1");
    expect(created).toHaveLength(0);
    expect(tx.user.createMany).not.toHaveBeenCalled();
    expect(out.credentials ?? []).toHaveLength(0);
  });
});

describe("the update is one statement, not one per pupil", () => {
  it("issues a single UPDATE for a whole batch", async () => {
    // A loop of `update()` calls inside an interactive transaction is the trap
    // this service already carries a comment about: Prisma caps one at FIVE
    // SECONDS, so a school correcting 400 records would get "Internal server
    // error" and whether it worked would depend on how busy the task was.
    const many = Array.from({ length: 120 }, (_, i) => ({
      ...ADA, id: `pf-${i}`, studentId: `u-${i}`, admissionNumber: `ADM-${200 + i}`, student: { name: `Pupil ${i}` },
    }));
    const { service, rawSql } = makeService({
      onRoll: many,
      batch: { id: "b1", status: "PENDING", uploadedById: "uploader", rows: many.map((m) => ({
        name: m.student.name, admissionNumber: m.admissionNumber, city: "Lagos",
      })) },
    });
    await service.approve(p("approver"), "b1");
    expect(rawSql.filter((r) => /UPDATE student_profile/.test(r.sql))).toHaveLength(1);
  });
});

describe("the result says what it did", () => {
  it("reports created AND updated, so a correction is not reported as a no-op", async () => {
    const { service } = makeService({
      batch: { id: "b1", status: "PENDING", uploadedById: "uploader", rows: [
        { name: "Ada Lovelace", admissionNumber: "ADM-001", city: "Lagos" },
        { name: "New Pupil", admissionNumber: "ADM-999" },
      ] },
    });
    const out = await service.approve(p("approver"), "b1");
    expect({ created: out.summary?.created, updated: out.summary?.updated, total: out.summary?.total })
      .toEqual({ created: 1, updated: 1, total: 2 });
  });
});
