// =============================================================================
// PendingApprovalsService — unified approvals inbox scoping tests
// =============================================================================
// The inbox surfaces work from OTHER modules, so the two rules that must mirror
// each source exactly are tested here:
//   1. a source is queried ONLY when the caller holds that source's permission;
//   2. rows the caller requested themselves are excluded (separation of duties),
//      matching each module's requester != approver rule.
// A caller holding nothing gets an empty list and touches no table.

import { PendingApprovalsService } from "../../src/approvals/pending-approvals.service";
import type { Principal, TenantContext, TenantTx } from "../../src/integrity/integrity.foundation";

const TABLES = [
  "invoiceAdjustment",
  "payment",
  "privilegeGrant",
  "salaryChangeRequest",
  "staffLoan",
  "staffExit",
  "employmentChangeRequest",
  "payrollRun",
  "admissionApplication",
  "erasureRequest",
] as const;

function makeService(rowsByTable: Partial<Record<(typeof TABLES)[number], unknown[]>> = {}) {
  const findMany: Record<string, jest.Mock> = {};
  const tx: Record<string, unknown> = {
    user: { findMany: jest.fn().mockResolvedValue([{ id: "other-1", name: "Bola" }]) },
  };
  for (const t of TABLES) {
    findMany[t] = jest.fn().mockResolvedValue(rowsByTable[t] ?? []);
    tx[t] = { findMany: findMany[t] };
  }
  const db = {
    runAsTenantReadOnly: <T>(_c: TenantContext, fn: (t: TenantTx) => Promise<T>) => fn(tx as unknown as TenantTx),
  };
  const service = new PendingApprovalsService(db as never);
  return { service, findMany };
}

const principal = (permissions: string[]): Principal => ({
  schoolId: "A",
  userId: "me",
  roles: [],
  permissions,
});

describe("PendingApprovalsService", () => {
  it("queries NO source when the caller holds no approval permission", async () => {
    const { service, findMany } = makeService();
    await expect(service.listPending(principal([]))).resolves.toEqual([]);
    for (const t of TABLES) expect(findMany[t]).not.toHaveBeenCalled();
  });

  it("fee.approve opens ONLY the two fee sources", async () => {
    const { service, findMany } = makeService();
    await service.listPending(principal(["fee.approve"]));
    expect(findMany.invoiceAdjustment).toHaveBeenCalled();
    expect(findMany.payment).toHaveBeenCalled();
    expect(findMany.salaryChangeRequest).not.toHaveBeenCalled();
    expect(findMany.privilegeGrant).not.toHaveBeenCalled();
    expect(findMany.payrollRun).not.toHaveBeenCalled();
  });

  it("hr.salary.approve opens the four HR sources but NOT payroll finalize", async () => {
    const { service, findMany } = makeService();
    await service.listPending(principal(["hr.salary.approve"]));
    expect(findMany.salaryChangeRequest).toHaveBeenCalled();
    expect(findMany.staffLoan).toHaveBeenCalled();
    expect(findMany.staffExit).toHaveBeenCalled();
    expect(findMany.employmentChangeRequest).toHaveBeenCalled();
    expect(findMany.payrollRun).not.toHaveBeenCalled(); // needs hr.payroll.run
  });

  it("excludes rows the caller requested themselves (separation of duties)", async () => {
    const { service, findMany } = makeService();
    await service.listPending(
      principal(["fee.approve", "security.elevation.approve", "hr.salary.approve", "hr.payroll.run", "privacy.erasure.review"]),
    );
    // Every self-requested exclusion uses that source's own requester column.
    expect(findMany.invoiceAdjustment.mock.calls[0][0].where).toMatchObject({ requestedById: { not: "me" } });
    expect(findMany.payment.mock.calls[0][0].where).toMatchObject({ recordedById: { not: "me" } });
    expect(findMany.privilegeGrant.mock.calls[0][0].where).toMatchObject({ requestedById: { not: "me" } });
    expect(findMany.staffExit.mock.calls[0][0].where).toMatchObject({ initiatedById: { not: "me" } });
    expect(findMany.payrollRun.mock.calls[0][0].where).toMatchObject({ runById: { not: "me" } });
    expect(findMany.erasureRequest.mock.calls[0][0].where).toMatchObject({ requestedById: { not: "me" } });
  });

  it("maps a pending item to a deep-linked inbox row, newest first", async () => {
    const older = new Date("2026-07-01T10:00:00Z");
    const newer = new Date("2026-07-20T10:00:00Z");
    const { service } = makeService({
      invoiceAdjustment: [
        { id: "adj1", kind: "WAIVER", amountMinor: 500000, reason: "Hardship", requestedById: "other-1", createdAt: older, invoiceId: "inv9" },
      ],
      payment: [{ id: "pay1", kind: "REFUND", amountMinor: 8500000, recordedById: "other-1", paidAt: newer, invoiceId: "inv3" }],
    });
    const res = await service.listPending(principal(["fee.approve"]));
    expect(res).toHaveLength(2);
    // Newest first.
    expect(res[0]).toMatchObject({
      source: "FEE_PAYMENT",
      label: "Refund awaiting approval",
      amountMinor: 8500000,
      href: "/fees/invoices/inv3",
      inline: false,
      detail: "requested by Bola",
    });
    expect(res[1]).toMatchObject({ source: "FEE_ADJUSTMENT", label: "Waiver — Hardship", href: "/fees/invoices/inv9" });
  });

  it("resolves requester names in ONE batched query, not per row (no N+1)", async () => {
    const d = new Date("2026-07-20T10:00:00Z");
    const rows = Array.from({ length: 25 }, (_, i) => ({
      id: `a${i}`, kind: "DISCOUNT", amountMinor: 100, reason: "r", requestedById: "other-1", createdAt: d, invoiceId: "inv1",
    }));
    const findMany: Record<string, jest.Mock> = {};
    const userFindMany = jest.fn().mockResolvedValue([{ id: "other-1", name: "Bola" }]);
    const tx: Record<string, unknown> = { user: { findMany: userFindMany } };
    for (const t of TABLES) {
      findMany[t] = jest.fn().mockResolvedValue(t === "invoiceAdjustment" ? rows : []);
      tx[t] = { findMany: findMany[t] };
    }
    const db = { runAsTenantReadOnly: <T>(_c: TenantContext, fn: (t: TenantTx) => Promise<T>) => fn(tx as unknown as TenantTx) };
    const service = new PendingApprovalsService(db as never);

    const res = await service.listPending(principal(["fee.approve"]));
    expect(res).toHaveLength(25);
    // 25 rows, ONE user lookup — and it asks for the DEDUPED id set.
    expect(userFindMany).toHaveBeenCalledTimes(1);
    expect(userFindMany.mock.calls[0][0].where.id.in).toEqual(["other-1"]);
  });
});
