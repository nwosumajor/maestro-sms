// =============================================================================
// A discipline case assigned to somebody they cannot see
// =============================================================================
// `assign` accepts any user in the school. `assigneeId` was then written and
// never read: it appeared in no read scope anywhere, and nothing notified the
// person. Both the list and the by-id read scoped to manager-or-complainant.
//
// So handing a case to a teacher told them nothing and showed them nothing — the
// list omitted it, fetching it by id returned 404, and the case sat unactioned
// while the manager believed it had been passed on. That is worse than having no
// assignment feature at all, because the feature creates the belief.
//
// The same family as the enum member whose readers were never updated: the
// writer was correct, the readers did not know about it, and both halves pass
// their own tests.
// =============================================================================

import { NotFoundException } from "@nestjs/common";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DisciplineService } from "../../src/discipline/discipline.service";

const COMPLAINT = "44444444-4444-4444-4444-444444444444";
const manager = { schoolId: "S", userId: "mgr-1", roles: ["principal"], permissions: ["discipline.manage"] };
const assignee = { schoolId: "S", userId: "teach-1", roles: ["teacher"], permissions: [] };
const stranger = { schoolId: "S", userId: "teach-2", roles: ["teacher"], permissions: [] };

function makeService(opts: { assignedTo?: string[]; complainantId?: string } = {}) {
  const assigned = (opts.assignedTo ?? []).map((id) => ({ complaintId: COMPLAINT, assigneeId: id, id: "a1" }));
  const enqueue = jest.fn().mockResolvedValue(undefined);
  // The row this school has. `get` now relies on the SCOPE to decide, rather
  // than re-deriving a rule inline, so the fixture has to honour the where —
  // returning the row unconditionally would make every scope test vacuous.
  const row: Record<string, unknown> = {
    id: COMPLAINT,
    complainantId: opts.complainantId ?? "someone-else",
    againstId: "pupil-9",
    againstType: "STUDENT",
    status: "OPEN",
  };
  const matches = (w: Record<string, unknown>): boolean =>
    Object.entries(w).every(([k, v]) => {
      if (k === "AND") return (v as Record<string, unknown>[]).every(matches);
      if (k === "OR") return (v as Record<string, unknown>[]).some(matches);
      if (k === "NOT") return !matches(v as Record<string, unknown>);
      if (v && typeof v === "object") return ((v as { in: string[] }).in ?? []).includes(row[k] as string);
      return row[k] === v;
    });
  const tx = {
    disciplineComplaint: {
      findFirst: jest.fn(async (a: { where: Record<string, unknown> }) => (matches(a.where) ? row : null)),
      findFirstOrThrow: jest.fn().mockResolvedValue({ id: COMPLAINT, complainantId: opts.complainantId ?? "someone-else", status: "OPEN" }),
      findMany: jest.fn().mockResolvedValue([]),
    },
    disciplineAssignee: {
      findMany: jest.fn(async (a: { where: { assigneeId: string } }) =>
        assigned.filter((x) => x.assigneeId === a.where.assigneeId),
      ),
      findFirst: jest.fn(async (a: { where: { assigneeId: string } }) =>
        assigned.find((x) => x.assigneeId === a.where.assigneeId) ?? null,
      ),
      create: jest.fn().mockResolvedValue({}),
    },
    disciplineEvidence: { findMany: jest.fn().mockResolvedValue([]) },
    disciplineEntry: { findMany: jest.fn().mockResolvedValue([]) },
    user: { findFirst: jest.fn().mockResolvedValue({ id: "teach-1" }), findMany: jest.fn().mockResolvedValue([]) },
  };
  const db = {
    runAsTenant: <T>(_c: unknown, fn: (t: unknown) => Promise<T>) => fn(tx),
    runAsTenantReadOnly: <T>(_c: unknown, fn: (t: unknown) => Promise<T>) => fn(tx),
  };
  const svc = Object.create(DisciplineService.prototype) as DisciplineService;
  Object.assign(svc, { db, audit: { record: jest.fn() }, notifications: { enqueue }, storage: {} });
  const scope = (
    svc as unknown as {
      visibleComplaintWhere: (t: unknown, p: unknown) => Promise<Record<string, unknown>>;
    }
  ).visibleComplaintWhere.bind(svc);
  return { svc, tx, scope, enqueue };
}

// The clause is now `{ AND: [ {NOT: about-me}, {OR: buckets} ] }` — see
// case-confidentiality.spec.ts for why the NOT exists. These tests are about the
// buckets, so they read them out of that envelope.
const bucketsOf = (where: Record<string, unknown>): Array<Record<string, unknown>> => {
  const and = where.AND as Array<Record<string, unknown>>;
  expect(and[0]).toEqual({ NOT: { againstId: expect.any(String) } });
  return and[1].OR as Array<Record<string, unknown>>;
};

describe("who can see a complaint", () => {
  it("a manager sees the school's", async () => {
    const { scope, tx } = makeService();
    // Leadership: everything EXCEPT a case about themselves. No bucket list and
    // no assignee lookup — there is nothing left for either to add.
    expect(await scope(tx, manager)).toEqual({ NOT: { againstId: "mgr-1" } });
    expect(tx.disciplineAssignee.findMany).not.toHaveBeenCalled();
  });

  it("somebody with no involvement sees only what they filed", async () => {
    const { scope, tx } = makeService();
    expect(bucketsOf(await scope(tx, stranger))).toEqual([{ complainantId: "teach-2" }]);
  });

  it("AN ASSIGNEE SEES THE CASE THEY WERE GIVEN", async () => {
    // The gap. Before this the clause was `{ complainantId }` and nothing else,
    // so the assignment was invisible to the person holding it.
    const { scope, tx } = makeService({ assignedTo: ["teach-1"] });
    expect(bucketsOf(await scope(tx, assignee))).toEqual([
      { complainantId: "teach-1" },
      { id: { in: [COMPLAINT] } },
    ]);
  });

  it("and NOTHING ELSE — the default stays closed", async () => {
    // These are records about children. Being assigned one case must not widen
    // sight of any other.
    const { scope, tx } = makeService({ assignedTo: ["teach-1"] });
    const buckets = bucketsOf(await scope(tx, assignee));
    expect(buckets).toHaveLength(2);
    expect(buckets[1]).toEqual({ id: { in: [COMPLAINT] } });
  });
});

describe("fetching one by id", () => {
  it("lets the assignee open it", async () => {
    const { svc } = makeService({ assignedTo: ["teach-1"] });
    await expect(svc.get(assignee as never, COMPLAINT)).resolves.toBeDefined();
  });

  it("still 404s somebody with no involvement", async () => {
    // 404 rather than 403 throughout: a 403 confirms a complaint exists about
    // somebody, which is itself the disclosure.
    const { svc } = makeService({ assignedTo: ["teach-1"] });
    await expect(svc.get(stranger as never, COMPLAINT)).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe("assigning tells them", () => {
  it("notifies the assignee", async () => {
    // Handing a case to somebody who is never informed is not handing it on.
    const { svc, enqueue } = makeService();
    await svc.assign(manager as never, COMPLAINT, "teach-1");
    expect(enqueue).toHaveBeenCalled();
    const payload = enqueue.mock.calls[0][1];
    expect(payload.recipientId).toBe("teach-1");
    expect(payload.title).toMatch(/assigned to you/i);
  });

  it("says nothing about the substance", async () => {
    // A pointer, not a summary. These are records about children and the
    // notification goes to an inbox that may be read on a shared screen.
    const { svc, enqueue } = makeService();
    await svc.assign(manager as never, COMPLAINT, "teach-1");
    const payload = enqueue.mock.calls[0][1];
    expect(payload.body).not.toMatch(/allegation|incident|student name/i);
    expect(payload.body).toMatch(/Open Discipline/);
  });
});

describe("the lookup this adds is indexed", () => {
  it("has an index leading on assignee, not just the unique on complaint", () => {
    // The existing unique is (complaintId, assigneeId), which cannot serve "which
    // cases am I responsible for?" — without a dedicated index that read scans
    // every assignment the school has ever made.
    const schema = readFileSync(
      join(__dirname, "../../../../packages/db/prisma/schema/discipline.prisma"),
      "utf8",
    );
    expect(schema).toMatch(/@@index\(\[schoolId, assigneeId\]\)/);
    const sql = readFileSync(
      join(__dirname, "../../../../packages/db/prisma/migrations/20261217000000_discipline_assignee_index/migration.sql"),
      "utf8",
    );
    expect(sql).toMatch(/CREATE INDEX IF NOT EXISTS[\s\S]*?"schoolId", "assigneeId"/);
  });
});
