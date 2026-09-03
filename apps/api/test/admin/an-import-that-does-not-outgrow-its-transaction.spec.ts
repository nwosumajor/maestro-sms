/**
 * A school importing its roll on day one got "Internal server error".
 *
 * `approve` ran 5-6 SEQUENTIAL round trips PER ROW inside ONE interactive
 * transaction, which Prisma caps at 5 SECONDS. Measured live against the running
 * stack, one school, nothing else happening:
 *
 *     25 rows   2.2 s      200 rows  37.1 s
 *     50 rows   4.6 s      300 rows  HTTP 500, batch left PENDING, 0 created
 *
 * and with four schools importing at once even a 20-row batch failed. The schema
 * permits 1,000. So whether a school could onboard depended on how many pupils it
 * had and how busy the task was, and the answer it got told it nothing.
 *
 * The rules are unchanged. What these tests pin is that the WORK is bounded: the
 * reads are batched, the row loop touches no database at all, and the writes are
 * bulk — so the transaction is milliseconds whatever the size of the roll.
 */
import bcrypt from "bcryptjs";
import { StudentImportService } from "../../src/admin/student-import.service";
import { hashEachWithoutBlocking } from "../../src/foundation/bulk-hash";
import type { Principal, TenantContext, TenantTx } from "../../src/integrity/integrity.foundation";

type Row = Record<string, unknown>;

function makeService(rows: Row[], opts: { existingEmails?: string[]; classes?: { id: string; capacity: number | null }[]; active?: Record<string, number> } = {}) {
  const existing = new Set((opts.existingEmails ?? []).map((e) => e.toLowerCase()));
  const calls: string[] = [];
  const state: { batch: Row | null } = { batch: { id: "b1", status: "PENDING", uploadedById: "uploader", rows } };
  const rec = (name: string, impl: (a?: never) => unknown) =>
    jest.fn((a?: never) => { calls.push(name); return Promise.resolve(impl(a)); });
  const tx = {
    user: {
      findMany: rec("user.findMany", (a?: never) => {
        const want = (a as unknown as { where?: { email?: { in?: string[] } } } | undefined)?.where?.email?.in;
        const all = [...existing];
        return (want ? all.filter((e) => want.includes(e)) : all).map((email) => ({ email }));
      }),
      findFirst: rec("user.findFirst", () => null),
      create: rec("user.create", () => ({ id: "u" })),
      createMany: rec("user.createMany", () => ({ count: 0 })),
    },
    userRole: { create: rec("userRole.create", () => ({})), createMany: rec("userRole.createMany", () => ({ count: 0 })) },
    studentProfile: {
      create: rec("studentProfile.create", () => ({})),
      createMany: rec("studentProfile.createMany", () => ({ count: 0 })),
      findMany: rec("studentProfile.findMany", () => []),
    },
    enrollment: {
      create: rec("enrollment.create", () => ({})),
      createMany: rec("enrollment.createMany", () => ({ count: 0 })),
      count: rec("enrollment.count", () => 0),
      groupBy: rec("enrollment.groupBy", () =>
        Object.entries(opts.active ?? {}).map(([classId, n]) => ({ classId, _count: { _all: n } }))),
    },
    class: {
      findMany: rec("class.findMany", () => opts.classes ?? []),
      findFirst: rec("class.findFirst", () => null),
    },
    role: { findFirst: rec("role.findFirst", () => ({ id: "student-role" })) },
    school: { findFirst: rec("school.findFirst", () => ({ slug: "demo" })) },
    studentImportBatch: {
      findFirst: rec("batch.findFirst", () => state.batch),
      update: jest.fn((a: { data: Row }) => { calls.push("batch.update"); state.batch = { ...state.batch, ...a.data }; return Promise.resolve(state.batch); }),
      updateMany: rec("batch.updateMany", () => ({ count: 1 })),
    },
  } as unknown as TenantTx;
  const db = { runAsTenant: <T,>(_c: TenantContext, fn: (t: TenantTx) => Promise<T>) => fn(tx) };
  const audit = { record: jest.fn().mockResolvedValue(undefined) };
  return { service: new StudentImportService(db as never, audit as never), calls, tx };
}
const p = (userId: string): Principal => ({ schoolId: "A", userId, roles: ["school_admin"], permissions: ["student.import"] });
const roll = (n: number) => Array.from({ length: n }, (_, i) => ({ name: `Pupil Number${i}` }));

describe("an import does not outgrow its transaction", () => {
  it("does the same number of queries for 60 pupils as for 5", async () => {
    const small = makeService(roll(5));
    await small.service.approve(p("approver"), "b1");
    const big = makeService(roll(60));
    await big.service.approve(p("approver"), "b1");
    // Bulk inserts are chunked at 500, so one extra chunk is the only difference
    // a bigger roll may make. Certainly not one query per pupil.
    expect(big.calls.length).toBeLessThanOrEqual(small.calls.length + 4);
    expect(big.calls.length).toBeLessThan(30);
  }, 60000);

  it("writes a whole roll without a single per-row create", async () => {
    const { service, calls } = makeService(roll(60));
    const res = await service.approve(p("approver"), "b1");
    expect(res.summary).toMatchObject({ created: 60, skipped: 0 });
    for (const perRow of ["user.create", "userRole.create", "studentProfile.create", "enrollment.create"]) {
      expect(calls.filter((c) => c === perRow)).toHaveLength(0);
    }
  }, 60000);

  it("asks for the taken identifiers ONCE, not once per candidate", async () => {
    // The auto-suffix allocator used to ask the database per candidate, and the
    // candidates come from a PURE function — so the whole window is one query.
    const { service, calls } = makeService(roll(60));
    await service.approve(p("approver"), "b1");
    expect(calls.filter((c) => c === "user.findMany")).toHaveLength(1);
    expect(calls.filter((c) => c === "user.findFirst")).toHaveLength(0);
  }, 60000);

  it("asks each class its capacity ONCE, not once per class per row", async () => {
    const rows = Array.from({ length: 60 }, (_, i) => ({ name: `Pupil C${i}`, classId: i % 2 ? "c1" : "c2" }));
    const { service, calls } = makeService(rows, {
      classes: [{ id: "c1", capacity: null }, { id: "c2", capacity: 100 }], active: { c2: 4 },
    });
    await service.approve(p("approver"), "b1");
    expect(calls.filter((c) => c === "class.findMany")).toHaveLength(1);
    expect(calls.filter((c) => c === "enrollment.groupBy")).toHaveLength(1);
    expect(calls.filter((c) => c === "enrollment.count")).toHaveLength(0);
    expect(calls.filter((c) => c === "class.findFirst")).toHaveLength(0);
  }, 60000);

  // The rules the batching must not have quietly dropped.
  it("still enforces a class's remaining capacity across the whole batch", async () => {
    const rows = Array.from({ length: 10 }, (_, i) => ({ name: `Pupil F${i}`, classId: "full" }));
    const { service } = makeService(rows, { classes: [{ id: "full", capacity: 7 }], active: { full: 4 } });
    const res = await service.approve(p("approver"), "b1");
    // three seats left, so three in and seven turned away
    expect(res.summary).toMatchObject({ created: 3, skipped: 7 });
  });

  it("still suffixes around identifiers the school ALREADY holds", async () => {
    const { service, tx } = makeService([{ name: "Chika Nwosu" }, { name: "Chika Nwosu" }], {
      existingEmails: ["chika.nwosu@demo.com", "chika.nwosu2@demo.com"],
    });
    await service.approve(p("approver"), "b1");
    const written = (tx as unknown as { user: { createMany: jest.Mock } }).user.createMany.mock.calls
      .flatMap((c) => (c[0] as { data: { email: string }[] }).data)
      .map((r) => r.email);
    expect(written).toEqual(["chika.nwosu3@demo.com", "chika.nwosu4@demo.com"]);
  });

  it("a race that beats the pre-check is a 409 naming the fix, never a 500", async () => {
    const { service, tx } = makeService(roll(3));
    const err = Object.assign(new Error("unique"), { code: "P2002" });
    Object.setPrototypeOf(err, (require("@sms/db").Prisma.PrismaClientKnownRequestError as { prototype: object }).prototype);
    (tx as unknown as { user: { createMany: jest.Mock } }).user.createMany.mockRejectedValueOnce(err);
    await expect(service.approve(p("approver"), "b1")).rejects.toMatchObject({
      status: 409,
      message: expect.stringContaining("approve it again"),
    });
  });
});

// -----------------------------------------------------------------------------
// The other half: hashing a roll must not stop the platform
// -----------------------------------------------------------------------------
describe("hashing a roll hands the event loop back", () => {
  it("yields between hashes instead of starving the loop for the whole batch", async () => {
    
    let ticks = 0;
    const iv = setInterval(() => { ticks += 1; }, 10);
    const t0 = Date.now();
    await hashEachWithoutBlocking(
      Array.from({ length: 12 }, (_, i) => i),
      (i: number) => `secret-${i}`,
      (i: number, secret: string, passwordHash: string) => ({ i, secret, passwordHash }),
    );
    clearInterval(iv);
    const ms = Date.now() - t0;
    // `Promise.all` over bcryptjs measured ONE tick where ~157 were due. Anything
    // near one tick per hash means the loop is being handed back.
    expect(ms).toBeGreaterThan(200); // the hashes really ran
    expect(ticks).toBeGreaterThanOrEqual(8);
  }, 60000);

  it("still produces a DISTINCT secret and a matching hash per row", async () => {
    
    
    const out = await hashEachWithoutBlocking(
      [1, 2, 3],
      () => Math.random().toString(36).slice(2),
      (row: number, secret: string, passwordHash: string) => ({ row, secret, passwordHash }),
    );
    expect(new Set(out.map((o) => o.secret)).size).toBe(3);
    for (const o of out) expect(await bcrypt.compare(o.secret, o.passwordHash)).toBe(true);
  }, 60000);
});

// -----------------------------------------------------------------------------
// A file bigger than one request can finish is refused, not attempted
// -----------------------------------------------------------------------------
describe("a roll bigger than one upload can carry", () => {
  it("is refused at the boundary, naming the number and the remedy", async () => {
    const { BULK_IMPORT_MAX_ROWS, bulkImportTooLarge } = await import("@sms/types");
    const msg = bulkImportTooLarge("student", BULK_IMPORT_MAX_ROWS + 1);
    expect(msg).toContain(String(BULK_IMPORT_MAX_ROWS));
    expect(msg).toContain(String(BULK_IMPORT_MAX_ROWS + 1));
    // It must say what to DO, because the alternative is a school retrying the
    // same file. And it must say the slips are shown once, which is the reason
    // losing the response matters at all.
    expect(msg).toMatch(/[Ss]plit/);
    expect(msg).toMatch(/shown only once/);
  });

  it("BOTH importers refuse, and with the same wording", async () => {
    const { bulkImportTooLarge } = await import("@sms/types");
    const a = bulkImportTooLarge("student", 900);
    const b = bulkImportTooLarge("parent", 900);
    expect(a).toContain("pupils");
    expect(b).toContain("guardians");
    // one sentence, one shape — two spellings of a limit is how a pair drifts
    expect(a.replace("pupils", "X")).toBe(b.replace("guardians", "X"));
  });

  it("the service refuses too — a guard on one door is not a guard", async () => {
    const { BULK_IMPORT_MAX_ROWS } = await import("@sms/types");
    const { service } = makeService([]);
    await expect(
      service.stage(p("uploader"), Array.from({ length: BULK_IMPORT_MAX_ROWS + 1 }, (_, i) => ({ name: `P${i}` }))),
    ).rejects.toMatchObject({ status: 400, message: expect.stringContaining("Split it") });
  }, 30000);

  it("the bound is small enough that an upload finishes inside a proxy timeout", async () => {
    // MEASURED: 132 ms a head. Sixty seconds is what the proxy in front of the
    // app allows, and the slips are lost if the response never arrives.
    const { BULK_IMPORT_MAX_ROWS } = await import("@sms/types");
    expect(BULK_IMPORT_MAX_ROWS * 0.145).toBeLessThan(40);
  });
});
