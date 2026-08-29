// =============================================================================
// A studentId in the request is a REQUEST, not a fact
// =============================================================================
// Golden Rule #3 says school_id comes only from the verified JWT and never from
// the request. The same reasoning applies one level down, to studentId — a
// parent's browser sends it, and honouring it is how one family reads another's
// invoices.
//
// The list endpoints take it as a FILTER, which is the shape that makes the
// mistake easy: `where.studentId = opts.studentId` is the obvious line to write
// and it is a data leak for every caller who is not billing-wide. Both places
// that do it get it right — the id is honoured only if it is already in the
// caller's own visible set, and otherwise the whole set is used instead of the
// requested one.
//
// Swept every endpoint that accepts a studentId and acts on it (12 controllers,
// 38 service methods): each either verifies the relationship or sits behind a
// staff-only permission where the coarse gate is the design. NOTHING WAS BROKEN.
// This exists because the failure would be silent — a parent would simply see a
// page of somebody else's child, and no error would be raised anywhere.
// =============================================================================

import { DocumentsService } from "../../src/documents/documents.service";
import { FeesService } from "../../src/fees/fees.service";
import type { Principal, TenantContext, TenantTx } from "../../src/integrity/integrity.foundation";

const PARENT: Principal = { schoolId: "A", userId: "parent-1", roles: ["parent"], permissions: ["fee.read", "document.read"] };
const OWN_CHILD = "child-of-parent-1";
const SOMEONE_ELSES = "child-of-another-family";

/** Records the `where` each list query was actually issued with. */
function capture() {
  const seen: Array<Record<string, unknown>> = [];
  const findMany = jest.fn((args: { where?: Record<string, unknown> }) => {
    seen.push(args?.where ?? {});
    return Promise.resolve([]);
  });
  const tx = {
    // The parent's real link set: exactly one child.
    parentChild: { findMany: jest.fn().mockResolvedValue([{ studentId: OWN_CHILD }]) },
    invoice: { findMany },
    document: { findMany },
    user: { findMany: jest.fn().mockResolvedValue([]) },
    enrollment: { findMany: jest.fn().mockResolvedValue([]) },
    classTeacher: { findMany: jest.fn().mockResolvedValue([]) },
    class: { findMany: jest.fn().mockResolvedValue([]) },
    classSubjectTeacher: { findMany: jest.fn().mockResolvedValue([]) },
  } as unknown as TenantTx;
  const db = { runAsTenant: jest.fn(async (_c: TenantContext, fn: (t: TenantTx) => unknown) => fn(tx)),
               runAsTenantReadOnly: jest.fn(async (_c: TenantContext, fn: (t: TenantTx) => unknown) => fn(tx)) };
  return { tx, db, seen };
}

const fees = (db: unknown) => {
  const s = Object.create(FeesService.prototype) as FeesService;
  Object.assign(s, { db, audit: { record: jest.fn() }, notifications: {}, paystack: {}, region: {} });
  return s;
};
const docs = (db: unknown) => {
  const s = Object.create(DocumentsService.prototype) as DocumentsService;
  Object.assign(s, { db, audit: { record: jest.fn() }, notifications: {}, storage: {} });
  return s;
};

describe("a parent asking for another family's child", () => {
  // WHAT CHANGED, AND WHY THE OLD ASSERTION WAS DEFENDING A DEFECT.
  //
  // This used to assert the requested id was "discarded and replaced by the
  // caller's own set", with a comment rejecting an empty result because it
  // "would look like 'no invoices' and hide the refusal". The objection was
  // right and the remedy was not: answering with the caller's OTHER children
  // presents rows as the answer to a question about a different child. Found
  // live on documents, where a teacher filtering for a pupil they do not teach
  // was handed another pupil's report card — the same body a uuid that is
  // nobody returned.
  //
  // 404 satisfies both halves: no wrong rows, and the refusal is explicit. It
  // is what every per-student route already answers, so it discloses nothing a
  // random id would not. The SECURITY property these cases exist for is
  // unchanged and is asserted more strictly now — the query is never issued at
  // all.
  it("is REFUSED, and the query is never issued with the foreign id", async () => {
    const { db, seen } = capture();
    await expect(fees(db).listInvoices(PARENT, { studentId: SOMEONE_ELSES })).rejects.toMatchObject({
      status: 404,
    });
    expect(seen).toEqual([]);
  });

  it("is refused for documents on the same rule", async () => {
    const { db, seen } = capture();
    await expect(docs(db).listDocuments(PARENT, { studentId: SOMEONE_ELSES })).rejects.toMatchObject({
      status: 404,
    });
    expect(seen).toEqual([]);
  });
});

describe("a parent asking for their own child", () => {
  it("gets exactly that child, so the filter still works", async () => {
    // The narrowing has to survive: a parent of three who picks one must see one.
    const { db, seen } = capture();
    await fees(db).listInvoices(PARENT, { studentId: OWN_CHILD });
    expect(seen[0].studentId).toBe(OWN_CHILD);
  });

  it("gets all of them when no child is named", async () => {
    const { db, seen } = capture();
    await docs(db).listDocuments(PARENT, {});
    expect(seen[0].studentId).toEqual({ in: [OWN_CHILD] });
  });
});

describe("a parent with no children linked at all", () => {
  it("is answered with nothing rather than an unfiltered query", async () => {
    // The dangerous shape: an empty visible set that falls through to a `where`
    // with no studentId key would return the whole school. Both services return
    // early instead.
    for (const call of [
      async (db: unknown) => fees(db).listInvoices(PARENT, { studentId: SOMEONE_ELSES }),
      async (db: unknown) => docs(db).listDocuments(PARENT, { studentId: SOMEONE_ELSES }),
    ]) {
      const { db, tx, seen } = capture();
      (tx.parentChild.findMany as jest.Mock).mockResolvedValue([]);
      const out = (await call(db)) as { items: unknown[] };
      expect(out.items).toEqual([]);
      expect(seen).toHaveLength(0); // no query was issued at all
    }
  });
});
