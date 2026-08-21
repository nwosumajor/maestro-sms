// =============================================================================
// A batch charge run with no batch way to finish it
// =============================================================================
// Fee runs are batches. Hostel rent charges every boarder, a transport run
// charges a route, a term's tuition charges a year group — and each charge
// lands on a DRAFT invoice, because a draft is where a bursar assembles a bill.
//
// There was no way to finish one. `POST /invoices/:id/issue` was the only issue
// path in the codebase and the web offers it on the single-invoice page, so
// making a 200-boarder rent run real meant opening 200 invoices one after
// another. What happens instead is that nobody does it, and the charges stay
// DRAFT — which the fees module itself defines as "not a bill yet": hidden from
// families, excluded from receivables and the ageing report, and refused by the
// payment path.
//
// So a school could approve a rent run through maker-checker, watch it create
// two hundred charges, and be owed nothing it could see or collect.
//
// The design decisions worth pinning are the two that keep this safe:
// explicit ids rather than "issue everything DRAFT" (a draft is by definition
// something somebody is still assembling), and partial success (an id that is
// no longer DRAFT is skipped and reported, not allowed to fail the batch).
// =============================================================================

import { FeesService } from "../../src/fees/fees.service";
import type { Principal, TenantContext, TenantTx } from "../../src/integrity/integrity.foundation";

function makeService(invoices: Array<{ id: string; status: string; studentId?: string }>) {
  const state = new Map(invoices.map((i) => [i.id, { ...i, studentId: i.studentId ?? `pupil-${i.id}` }]));
  const updateMany = jest.fn(({ where }: { where: { id: string; status: string } }) => {
    const inv = state.get(where.id);
    if (!inv || inv.status !== where.status) return Promise.resolve({ count: 0 });
    inv.status = "ISSUED";
    return Promise.resolve({ count: 1 });
  });
  const tx = {
    invoice: {
      updateMany,
      findFirst: jest.fn(({ where }: { where: { id: string } }) => {
        const inv = state.get(where.id);
        return Promise.resolve(
          inv
            ? {
                id: inv.id,
                studentId: inv.studentId,
                status: inv.status,
                reference: `REF-${inv.id}`,
                totalMinor: 150000,
                currency: "NGN",
                dueDate: new Date("2026-09-01"),
              }
            : null,
        );
      }),
    },
    parentChild: { findMany: jest.fn().mockResolvedValue([{ parentId: "mum" }]) },
    auditLog: { create: jest.fn() },
  } as unknown as TenantTx;
  const enqueue = jest.fn().mockResolvedValue(undefined);
  const db = { runAsTenant: <T>(_c: TenantContext, fn: (t: TenantTx) => Promise<T>) => fn(tx) };
  const svc = Object.create(FeesService.prototype) as FeesService;
  Object.assign(svc, {
    db,
    audit: { record: jest.fn() },
    notifications: { enqueue },
    logger: { error: jest.fn(), log: jest.fn(), warn: jest.fn() },
  });
  return { svc, updateMany, enqueue, state };
}

const bursar: Principal = { schoolId: "A", userId: "acc-1", roles: ["accountant"], permissions: ["fee.manage"] };

describe("issuing a run's drafts", () => {
  it("issues every draft in the batch", async () => {
    const { svc, state } = makeService([
      { id: "a", status: "DRAFT" },
      { id: "b", status: "DRAFT" },
      { id: "c", status: "DRAFT" },
    ]);
    const r = await svc.issueInvoices(bursar, ["a", "b", "c"]);
    expect(r.issued.sort()).toEqual(["a", "b", "c"]);
    expect(r.skipped).toEqual([]);
    expect([...state.values()].every((i) => i.status === "ISSUED")).toBe(true);
  });

  it("skips what is no longer a draft and says why", async () => {
    // A colleague issued one a second ago, another was cancelled. Failing the
    // whole batch would send the bursar round again wondering which half took.
    const { svc } = makeService([
      { id: "a", status: "DRAFT" },
      { id: "b", status: "ISSUED" },
      { id: "c", status: "CANCELLED" },
    ]);
    const r = await svc.issueInvoices(bursar, ["a", "b", "c"]);
    expect(r.issued).toEqual(["a"]);
    expect(r.skipped).toEqual([
      { id: "b", reason: "already ISSUED" },
      { id: "c", reason: "already CANCELLED" },
    ]);
  });

  it("reports an unknown id rather than pretending", async () => {
    const { svc } = makeService([{ id: "a", status: "DRAFT" }]);
    const r = await svc.issueInvoices(bursar, ["a", "ghost"]);
    expect(r.issued).toEqual(["a"]);
    expect(r.skipped).toEqual([{ id: "ghost", reason: "not found" }]);
  });

  it("claims each invoice instead of reading then writing", async () => {
    // Two bursars pressing this on the same batch would otherwise both issue it
    // and both notify the family.
    const { svc, updateMany } = makeService([{ id: "a", status: "DRAFT" }]);
    await svc.issueInvoices(bursar, ["a"]);
    expect(updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "a", status: "DRAFT" } }),
    );
  });

  it("collapses a duplicate id instead of reporting it as a skip", async () => {
    // A double-submitted form must not send the family two notices for one
    // bill, and the CLAIM is what guarantees that — the second pass finds the
    // invoice no longer DRAFT. Deduplicating first is not the safety property;
    // it saves the wasted round-trip AND keeps the result honest, because
    // without it the same invoice appears in `skipped` as "already ISSUED",
    // which reads like a problem rather than a repeated id.
    const { svc, enqueue } = makeService([{ id: "a", status: "DRAFT" }]);
    const r = await svc.issueInvoices(bursar, ["a", "a", "a"]);
    expect(r.issued).toEqual(["a"]);
    expect(r.skipped).toEqual([]);
    expect(enqueue).toHaveBeenCalledTimes(1);
  });
});

describe("telling the families", () => {
  it("notifies the guardians of every invoice it issued, and nobody else's", async () => {
    const { svc, enqueue } = makeService([
      { id: "a", status: "DRAFT" },
      { id: "b", status: "ISSUED" },
    ]);
    await svc.issueInvoices(bursar, ["a", "b"]);
    expect(enqueue).toHaveBeenCalledTimes(1);
    expect((enqueue.mock.calls[0][1] as { title: string }).title).toBe("New invoice");
  });

  it("does not undo real bills when a notice fails", async () => {
    // The invoices are ISSUED and committed by the time anyone is told.
    const { svc, enqueue, state } = makeService([{ id: "a", status: "DRAFT" }]);
    enqueue.mockRejectedValue(new Error("smtp down"));
    await expect(svc.issueInvoices(bursar, ["a"])).resolves.toMatchObject({ issued: ["a"] });
    expect(state.get("a")?.status).toBe("ISSUED");
  });
});
