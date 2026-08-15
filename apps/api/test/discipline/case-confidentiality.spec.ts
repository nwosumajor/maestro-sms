// =============================================================================
// The accused read the complaint, saw who filed it, and dismissed it
// =============================================================================
// `discipline.manage` is held by principal, school_admin AND teacher. The row
// scope for a manager was `{}` — the whole school. Nothing anywhere excluded the
// person a complaint was ABOUT. Live, against the running stack:
//
//   pupil files against their teacher -> 201
//   the ACCUSED TEACHER reads it      -> 200
//      details   : CONFIDENTIAL-PROBE-BODY
//      complainant named: "Demo Student"
//   the ACCUSED can RESOLVE it        -> 201
//
// So a child reports a teacher's conduct, and that teacher reads the allegation,
// learns which child made it, and marks it DISMISSED. There is no separation of
// duties at all, and the complainant is a minor.
//
// TWO fixes, because there are two distinct faults:
//
//   1. A complaint is never visible to its SUBJECT, whatever they hold. Being
//      told you have been complained about is a deliberate act by whoever
//      handles the case — not a side effect of a permission you carry.
//
//   2. A STAFF-conduct case is school-wide-visible only to leadership. Every
//      classroom teacher holding `discipline.manage` is right for cases about
//      pupils and wrong for cases about colleagues: a pupil reporting a teacher
//      should reach the head, not the staffroom. Filers and assignees still see
//      their own such cases.
//
// The predicate is exercised here against real rows, not asserted as a string —
// a where-clause that reads correctly and matches the wrong rows is the whole
// danger.
// =============================================================================

import { BadRequestException, NotFoundException } from "@nestjs/common";
import { DisciplineService } from "../../src/discipline/discipline.service";
import type { Principal, TenantContext, TenantTx } from "../../src/integrity/integrity.foundation";

type Row = { id: string; complainantId: string; againstId: string; againstType: string; status: string };

const CASES: Row[] = [
  { id: "c-pupil", complainantId: "teacher-1", againstId: "pupil-9", againstType: "STUDENT", status: "OPEN" },
  { id: "c-staff", complainantId: "pupil-1", againstId: "teacher-1", againstType: "TEACHER", status: "OPEN" },
  { id: "c-staff-other", complainantId: "pupil-2", againstId: "teacher-2", againstType: "TEACHER", status: "OPEN" },
  // A case about the PRINCIPAL. This one is load-bearing: leadership sees every
  // staff case, so it is the only fixture where nothing BUT the subject
  // exclusion stands between the accused and the file. Without it these tests
  // passed with the exclusion deleted — the staff-case narrowing was quietly
  // doing the work, and a whole defect would have gone on being untested.
  { id: "c-head", complainantId: "pupil-1", againstId: "head-1", againstType: "TEACHER", status: "OPEN" },
];

// A minimal evaluator for the operators the scope actually uses. Anything else
// throws, so the test can never quietly pass on a clause it did not understand.
function matches(where: Record<string, unknown>, row: Row): boolean {
  return Object.entries(where).every(([k, v]) => {
    if (k === "AND") return (v as Record<string, unknown>[]).every((w) => matches(w, row));
    if (k === "OR") return (v as Record<string, unknown>[]).some((w) => matches(w, row));
    if (k === "NOT") return !matches(v as Record<string, unknown>, row);
    const actual = (row as unknown as Record<string, unknown>)[k];
    if (v && typeof v === "object" && "in" in (v as object)) {
      return ((v as { in: string[] }).in ?? []).includes(actual as string);
    }
    if (v && typeof v === "object") throw new Error(`unsupported operator on ${k}: ${JSON.stringify(v)}`);
    return actual === v;
  });
}

const who = (userId: string, roles: string[], permissions: string[]): Principal => ({
  schoolId: "school-A",
  userId,
  roles,
  permissions,
});

const MANAGE = ["discipline.file", "discipline.manage"];
const accusedTeacher = who("teacher-1", ["teacher"], MANAGE);
const otherTeacher = who("teacher-3", ["teacher"], MANAGE);
const principal = who("head-1", ["principal"], MANAGE);
const admin = who("admin-1", ["school_admin"], MANAGE);
const pupil = who("pupil-1", ["student"], ["discipline.file"]);

function makeService(opts: { assignedTo?: Record<string, string[]> } = {}) {
  const { assignedTo = {} } = opts; // userId -> complaint ids
  const seen: Record<string, unknown>[] = [];
  const find = (args: { where: Record<string, unknown> }): Row | null => {
    seen.push(args.where);
    return CASES.find((r) => matches(args.where, r)) ?? null;
  };
  const tx = {
    disciplineAssignee: {
      findMany: jest.fn(async (args: { where: { assigneeId: string } }) =>
        (assignedTo[args.where.assigneeId] ?? []).map((complaintId) => ({ complaintId })),
      ),
      findFirst: jest.fn(async (args: { where: { assigneeId: string; complaintId: string } }) =>
        (assignedTo[args.where.assigneeId] ?? []).includes(args.where.complaintId) ? { id: "a-1" } : null,
      ),
    },
    disciplineComplaint: {
      findFirst: jest.fn(async (args: { where: Record<string, unknown> }) => find(args)),
      findMany: jest.fn(async (args: { where: Record<string, unknown> }) =>
        CASES.filter((r) => matches(args.where, r)),
      ),
      update: jest.fn(async () => ({})),
    },
    disciplineEntry: { create: jest.fn(async () => ({})), findMany: jest.fn(async () => []) },
    disciplineEvidence: { findMany: jest.fn(async () => []), findFirst: jest.fn(async () => null) },
    user: { findFirst: jest.fn(async () => ({ id: "u-1" })), findMany: jest.fn(async () => []) },
    parentChild: { findMany: jest.fn(async () => []) },
    auditLog: { create: jest.fn(async () => ({})) },
  } as unknown as TenantTx;
  const db = { runAsTenant: <T>(_c: TenantContext, fn: (t: TenantTx) => Promise<T>) => fn(tx) };
  const service = new DisciplineService(
    db as never,
    { record: jest.fn() } as never,
    { presignDownload: jest.fn(), presignUpload: jest.fn() } as never,
    { enqueue: jest.fn(), enqueueMany: jest.fn() } as never,
  );
  // complaintDto reads a lot; the scope decision happens before it, and every
  // test below asserts on the decision.
  jest.spyOn(service as never, "complaintDto").mockResolvedValue({ id: "ok" } as never);
  return { service, tx, seen };
}

describe("a complaint about you", () => {
  it("is invisible to you, even holding discipline.manage", async () => {
    // THE defect. c-staff is about teacher-1.
    const { service } = makeService();
    await expect(service.get(accusedTeacher, "c-staff")).rejects.toBeInstanceOf(NotFoundException);
  });

  it("is invisible to the PRINCIPAL when it is about the principal", async () => {
    // The case that isolates this rule from every other one: leadership sees
    // all staff cases, so only the subject exclusion can refuse this.
    const { service } = makeService();
    await expect(service.get(principal, "c-head")).rejects.toBeInstanceOf(NotFoundException);
  });

  it("cannot be DISMISSED by the principal it names", async () => {
    const { service } = makeService();
    await expect(
      service.resolve(principal, "c-head", { status: "DISMISSED", resolution: "unfounded" }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it("does not appear in the principal's list either", async () => {
    const { service, tx } = makeService();
    await service.list(principal);
    const rows = await (tx.disciplineComplaint.findMany as jest.Mock).mock.results[0].value;
    expect(rows.map((r: Row) => r.id)).not.toContain("c-head");
  });

  it("is still handled by the OTHER leadership role", async () => {
    // It must move sideways, not disappear: the school_admin still has it.
    const { service } = makeService();
    await expect(service.get(admin, "c-head")).resolves.toBeDefined();
  });

  it("stays hidden even when the case was ASSIGNED to you", async () => {
    // An assignment cannot be used to hand somebody the file about themselves.
    const { service } = makeService({ assignedTo: { "teacher-1": ["c-staff"] } });
    await expect(service.get(accusedTeacher, "c-staff")).rejects.toBeInstanceOf(NotFoundException);
  });

  it("cannot be RESOLVED by you", async () => {
    // Reading it was bad; dismissing the case against yourself is worse.
    const { service } = makeService();
    await expect(
      service.resolve(accusedTeacher, "c-staff", { status: "DISMISSED", resolution: "no case" }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it("cannot be ASSIGNED by you", async () => {
    const { service } = makeService();
    await expect(service.assign(accusedTeacher, "c-staff", "someone")).rejects.toBeInstanceOf(NotFoundException);
  });

  it("cannot have an entry added by you", async () => {
    const { service } = makeService();
    await expect(service.addEntry(accusedTeacher, "c-staff", "my side")).rejects.toBeInstanceOf(NotFoundException);
  });

  it("does not appear in your list", async () => {
    const { service, tx } = makeService();
    await service.list(accusedTeacher);
    const rows = await (tx.disciplineComplaint.findMany as jest.Mock).mock.results[0].value;
    expect(rows.map((r: Row) => r.id)).not.toContain("c-staff");
  });

  it("is still visible to the people who should handle it", async () => {
    // The case must not vanish — it must move up.
    const { service } = makeService();
    await expect(service.get(principal, "c-staff")).resolves.toBeDefined();
  });

  it("refuses to be created in the first place", async () => {
    const { service } = makeService();
    await expect(
      service.file(accusedTeacher, { subject: "s", againstId: "teacher-1", againstType: "TEACHER" }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});

describe("a complaint about a member of staff", () => {
  it("is NOT school-wide readable by an unrelated teacher", async () => {
    // c-staff-other is about teacher-2 and concerns teacher-3 not at all.
    const { service } = makeService();
    await expect(service.get(otherTeacher, "c-staff-other")).rejects.toBeInstanceOf(NotFoundException);
  });

  it("IS readable by the principal", async () => {
    const { service } = makeService();
    await expect(service.get(principal, "c-staff-other")).resolves.toBeDefined();
  });

  it("is readable by the teacher who FILED it", async () => {
    const filer = who("teacher-1", ["teacher"], MANAGE);
    const { service } = makeService();
    // c-pupil was filed by teacher-1 — a pupil case they raised.
    await expect(service.get(filer, "c-pupil")).resolves.toBeDefined();
  });

  it("is readable by a teacher it was ASSIGNED to", async () => {
    // Leadership can still hand a staff case to a senior colleague.
    const { service } = makeService({ assignedTo: { "teacher-3": ["c-staff-other"] } });
    await expect(service.get(otherTeacher, "c-staff-other")).resolves.toBeDefined();
  });
});

describe("what stays exactly as it was", () => {
  it("a teacher still sees the school's PUPIL cases", async () => {
    // The narrowing is about staff-conduct cases only. Day-to-day discipline is
    // unchanged, or the module stops working.
    const { service } = makeService();
    await expect(service.get(otherTeacher, "c-pupil")).resolves.toBeDefined();
  });

  it("a filer still sees the case they raised", async () => {
    const { service } = makeService();
    await expect(service.get(pupil, "c-staff")).resolves.toBeDefined();
  });

  it("a pupil sees nothing they neither filed nor were assigned", async () => {
    const { service } = makeService();
    await expect(service.get(pupil, "c-pupil")).rejects.toBeInstanceOf(NotFoundException);
  });

  it("every refusal is a 404, never a 403", async () => {
    // A 403 would confirm a complaint exists about somebody.
    const { service } = makeService();
    await expect(service.get(accusedTeacher, "c-staff")).rejects.toMatchObject({ status: 404 });
  });
});
