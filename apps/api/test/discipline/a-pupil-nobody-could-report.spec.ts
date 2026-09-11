// =============================================================================
// 690 pupils who could not be named in a complaint
// =============================================================================
// `GET /discipline/file-targets` returned the people a caller may file AGAINST:
// a bare array, ordered by name, capped at 500, with no search and no count. The
// form rendered it as a plain `<select>`.
//
// Measured on a 1,200-pupil roll whose surnames span the alphabet:
//
//     returned          500 of 1,200
//     range             Asurname… .. Ksurname…
//     ?q= accepted      NO — the parameter was ignored
//     said there were more   nothing
//
// So a pupil whose name sorted past the cap could not be reported AT ALL. Not
// "harder to find": absent from the only control that names them, with nothing
// on screen to say why. 690 of 1,200 — and this is the safeguarding path, where
// a concern that cannot be filed is a concern that goes unrecorded.
//
// The relationship scoping was never the problem and must not move: a pupil may
// still name only a classmate, a filer with no class may still name a teacher
// and no pupil. What was missing was a way to REACH the people already allowed.
// =============================================================================

import { DisciplineService } from "../../src/discipline/discipline.service";
import type { Principal, TenantContext, TenantTx } from "../../src/integrity/integrity.foundation";

const head: Principal = {
  schoolId: "A",
  userId: "head",
  roles: ["principal"],
  permissions: ["discipline.file", "discipline.manage"],
};
const pupil: Principal = {
  schoolId: "A",
  userId: "stu-0001",
  roles: ["student"],
  permissions: ["discipline.file"],
};

/** A roll spanning the alphabet, so a name-ordered cap lands mid-school. */
const ROLL = Array.from({ length: 1200 }, (_, i) => ({
  id: `stu-${String(i).padStart(4, "0")}`,
  name: `${String.fromCharCode(65 + (i % 26))}surname${String(i).padStart(4, "0")}`,
}));

/** A pupil's own class: five classmates, bounded by the class not the school. */
const CLASSMATES = ROLL.slice(0, 6);

function makeService(rows = ROLL, inClass: "c1" | null = null) {
  const match = (where: Record<string, unknown>) => {
    const needle = (where.name as { contains?: string } | undefined)?.contains;
    const ids = (where.id as { in?: string[] } | undefined)?.in;
    return rows
      .filter((r) => (ids ? ids.includes(r.id) : true))
      .filter((r) => (needle ? r.name.toLowerCase().includes(needle.toLowerCase()) : true));
  };
  const tx = {
    user: {
      // HONOURS the where AND the take — a stub that ignores either reports a
      // cap that is not there, or a search that is not happening.
      findMany: jest.fn(async ({ where, take }: { where: Record<string, unknown>; take?: number }) => {
        const out = match(where).sort((a, b) => (a.name < b.name ? -1 : 1));
        return take ? out.slice(0, take) : out;
      }),
      count: jest.fn(async ({ where }: { where: Record<string, unknown> }) => match(where).length),
    },
    enrollment: {
      // Answers BOTH questions it is asked: which class is this pupil in, and
      // who else is in that class.
      findMany: jest.fn(async ({ where }: { where: Record<string, unknown> }) =>
        inClass === null
          ? []
          : where.studentId
            ? [{ classId: "c1" }]
            : CLASSMATES.map((c) => ({ studentId: c.id })),
      ),
    },
    classSubjectTeacher: { findMany: jest.fn(async () => []) },
    class: { findMany: jest.fn(async () => []) },
    // A double must model the CONTRACT: relatedClassIds asks for the caller's
    // children too, and a stub missing the method fails as a code fault.
    parentChild: { findMany: jest.fn(async () => []) },
  } as unknown as TenantTx;

  const svc = new DisciplineService(
    {
      runAsTenant: <T,>(_c: TenantContext, fn: (t: TenantTx) => Promise<T>) => fn(tx),
      runAsTenantReadOnly: <T,>(_c: TenantContext, fn: (t: TenantTx) => Promise<T>) => fn(tx),
    } as never,
    { record: jest.fn() } as never,
    { enqueue: jest.fn(), enqueueMany: jest.fn(), notifyPermissionHolders: jest.fn() } as never,
    { presignUpload: jest.fn(), presignDownload: jest.fn() } as never,
  );
  return { svc, tx };
}

describe("a manager filing against a 1,200-pupil roll", () => {
  it("SAYS HOW MANY they may name, not how many fit the cap", async () => {
    const { svc } = makeService();
    const r = await svc.listFileTargets(head, "STUDENT");
    expect(r.items.length).toBeLessThan(1200);
    expect(r.total).toBe(1200);
    expect(r.searchable).toBe(true);
  });

  it("can REACH a pupil past the cap by name — the 690 who could not be reported", async () => {
    const { svc } = makeService();
    const unseeded = await svc.listFileTargets(head, "STUDENT");
    const target = "Zsurname0025";
    // Not in the first page: this is the pupil the old form could not offer.
    expect(unseeded.items.some((u) => u.name === target)).toBe(false);
    const found = await svc.listFileTargets(head, "STUDENT", target);
    expect(found.items.map((u) => u.name)).toContain(target);
    expect(found.total).toBe(1);
  });

  it("searches in the DATABASE, not over the page it already fetched", async () => {
    const { svc, tx } = makeService();
    await svc.listFileTargets(head, "STUDENT", "Zsurname");
    const findMany = (tx as unknown as { user: { findMany: jest.Mock } }).user.findMany;
    expect(JSON.stringify(findMany.mock.calls[0][0].where)).toMatch(/contains/);
  });

  it("counts the MATCHES when searching, not the whole roll", async () => {
    const { svc } = makeService();
    const r = await svc.listFileTargets(head, "STUDENT", "Zsurname");
    expect(r.total).toBe(r.items.length);
    expect(r.total).toBeLessThan(1200);
  });

  it("answers a query nobody matches with nothing, and says so as zero", async () => {
    const { svc } = makeService();
    const r = await svc.listFileTargets(head, "STUDENT", "nobodyxyz");
    expect(r.items).toEqual([]);
    expect(r.total).toBe(0);
  });
});

describe("the relationship scoping does not move", () => {
  it("a pupil with no class may name NOBODY, search or not", async () => {
    // Widening the reach must not widen the RULE: a pupil may name a classmate,
    // never the school. The search is a way to reach who is already allowed.
    const { svc } = makeService();
    const plain = await svc.listFileTargets(pupil, "STUDENT");
    const searched = await svc.listFileTargets(pupil, "STUDENT", "Zsurname");
    expect(plain.items).toEqual([]);
    expect(searched.items).toEqual([]);
    expect(searched.total).toBe(0);
  });

  it("a pupil's CLASSMATES arrive whole, and are not marked searchable", async () => {
    // Bounded by the class, not the school: there is nothing past a cap to go
    // looking for, and the screen should not offer a search that finds nothing
    // new. (A pupil with NO class falls into the "any teacher" branch instead,
    // which IS the whole staff and IS searchable — a different question, and
    // the first draft of this test asserted it against the wrong branch.)
    const { svc } = makeService(ROLL, "c1");
    const r = await svc.listFileTargets(pupil, "STUDENT");
    expect(r.searchable).toBe(false);
    // Everyone in the class except the caller.
    expect(r.items.map((u) => u.id)).not.toContain(pupil.userId);
    expect(r.total).toBe(r.items.length);
    expect(r.total).toBeGreaterThan(0);
  });
});
