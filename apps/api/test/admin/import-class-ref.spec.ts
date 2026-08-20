// =============================================================================
// The import template's class column
// =============================================================================
// It used to be `classId` — a raw 36-character uuid, one per pupil. Nobody has
// that: filling in the spreadsheet meant digging an id out of a URL for every
// class, pasting it hundreds of times, and then being unable to check your own
// work, because a column of uuids cannot be read back.
//
// It now takes what the school already calls the class. The half that matters
// most is the DRY RUN reporting a value that matched nothing — a misspelt class
// would otherwise enrol the pupil nowhere and say so never.
// =============================================================================

import { StudentImportService } from "../../src/admin/student-import.service";
import type { Principal, TenantTx } from "../../src/integrity/integrity.foundation";

// Bcrypt at cost factor 10 dominates this suite's runtime — that is the security
// parameter doing its job, not slow code, so the timeout moves rather than the
// cost. At the 5s default these pass alone and fail under full-suite
// parallelism, which teaches people to re-run a red suite instead of reading it.
jest.setTimeout(60_000);


const admin = { userId: "a1", schoolId: "s1", roles: ["school_admin"], permissions: [] } as unknown as Principal;

/** Honours the where — resolution IS the behaviour under test. */
function harness(classes: Array<{ id: string; name: string; code: string }>) {
  let staged: Record<string, unknown> | null = null;
  const tx = {
    class: {
      findFirst: jest.fn((args: { where: { OR?: Array<Record<string, unknown>> } }) => {
        const or = args.where.OR ?? [];
        // HONOURS `mode`. The first version lowercased both sides itself, so it
        // matched case-insensitively whatever the service asked for — removing
        // `mode: "insensitive"` changed nothing and the test could not fail. A
        // fake must reflect the query, not re-implement the behaviour.
        const cmp = (cond: { equals?: string; mode?: string } | undefined, actual: string) => {
          if (!cond?.equals) return false;
          return cond.mode === "insensitive"
            ? cond.equals.toLowerCase() === actual.toLowerCase()
            : cond.equals === actual;
        };
        const hit = classes.find((c) =>
          or.some((cond) => {
            if (cond.id) return cond.id === c.id;
            return (
              cmp(cond.code as { equals?: string; mode?: string }, c.code) ||
              cmp(cond.name as { equals?: string; mode?: string }, c.name)
            );
          }),
        );
        return Promise.resolve(hit ? { id: hit.id } : null);
      }),
    },
    user: { findMany: jest.fn().mockResolvedValue([]) },
    studentImportBatch: {
      create: jest.fn((args: { data: Record<string, unknown> }) => {
        staged = args.data;
        return Promise.resolve({ id: "b1", status: "PENDING", uploadedById: "a1", reviewedById: null, ...args.data, createdAt: new Date() });
      }),
    },
    auditLog: { create: jest.fn().mockResolvedValue({}) },
  } as unknown as TenantTx;
  const db = { runAsTenant: <T>(_c: unknown, fn: (t: TenantTx) => Promise<T>) => fn(tx) };
  const svc = new StudentImportService(db as never, { record: jest.fn().mockResolvedValue(undefined) } as never);
  return { svc, tx, get staged() { return staged; } };
}

const CLASSES = [{ id: "11111111-1111-1111-1111-111111111111", name: "SS3 Science A", code: "AB12CD34" }];
const summaryOf = (staged: Record<string, unknown> | null) => staged?.summary as { unknownClasses?: string[] };
const rowsOf = (staged: Record<string, unknown> | null) => staged?.rows as Array<{ classId: string | null }>;

describe("the template header", () => {
  it("offers `class`, not `classId`", () => {
    const h = harness(CLASSES);
    const header = h.svc.csvTemplate().split("\n")[0];
    expect(header.endsWith(",class")).toBe(true);
    expect(header).not.toContain("classId");
  });

  it("SHOWS a class written the way a school writes it", async () => {
    // The sample rows are the documentation most people will read.
    const h = harness(CLASSES);
    expect(h.svc.csvTemplate()).toContain("SS3 Science A");
  });
});

describe("resolving what was typed", () => {
  it("matches the class NAME", async () => {
    const h = harness(CLASSES);
    await h.svc.stage(admin, [{ name: "Ada", class: "SS3 Science A" }] as never);
    expect(rowsOf(h.staged)[0].classId).toBe(CLASSES[0].id);
  });

  it("matches case-insensitively, because that is what people type", async () => {
    const h = harness(CLASSES);
    await h.svc.stage(admin, [{ name: "Ada", class: "ss3 science a" }] as never);
    expect(rowsOf(h.staged)[0].classId).toBe(CLASSES[0].id);
  });

  it("matches the class CODE", async () => {
    const h = harness(CLASSES);
    await h.svc.stage(admin, [{ name: "Ada", class: "AB12CD34" }] as never);
    expect(rowsOf(h.staged)[0].classId).toBe(CLASSES[0].id);
  });

  it("still accepts a uuid, so a file somebody already built keeps working", async () => {
    const h = harness(CLASSES);
    await h.svc.stage(admin, [{ name: "Ada", classId: CLASSES[0].id }] as never);
    expect(rowsOf(h.staged)[0].classId).toBe(CLASSES[0].id);
  });

  it("resolves each distinct value ONCE, not once per pupil", async () => {
    // A 300-row file names a handful of classes; a lookup per row would be 300
    // queries to answer the same question.
    const h = harness(CLASSES);
    await h.svc.stage(
      admin,
      Array.from({ length: 20 }, (_, i) => ({ name: `P${i}`, class: "SS3 Science A" })) as never,
    );
    expect((h.tx.class.findFirst as jest.Mock).mock.calls).toHaveLength(1);
  });
});

describe("a value that matches nothing", () => {
  it("is reported by the DRY RUN, before anything is created", async () => {
    const h = harness(CLASSES);
    await h.svc.stage(admin, [
      { name: "Ada", class: "SS3 Science A" },
      { name: "Bolu", class: "SS3 Sceince A" },
    ] as never);
    expect(summaryOf(h.staged).unknownClasses).toEqual(["SS3 Sceince A"]);
  });

  it("leaves that pupil's class NULL rather than guessing", async () => {
    // Enrolling them in the nearest-looking class would be worse than not
    // enrolling them: nobody would ever notice.
    const h = harness(CLASSES);
    await h.svc.stage(admin, [{ name: "Bolu", class: "Nowhere" }] as never);
    expect(rowsOf(h.staged)[0].classId).toBeNull();
  });

  it("says nothing when every class matched", async () => {
    const h = harness(CLASSES);
    await h.svc.stage(admin, [{ name: "Ada", class: "SS3 Science A" }] as never);
    expect(summaryOf(h.staged).unknownClasses).toBeUndefined();
  });
});
