// =============================================================================
// Subscription reconciliation — the platform's OWN revenue had no safety net
// =============================================================================
// The daily sweep listed the gateway's settled charges and recovered any that
// never reached the ledger. It filtered on `kind === "invoice"` and dropped
// everything else on the floor — so parent fees were protected and the
// platform's subscription income was not.
//
// The consequence is the worst possible ordering: the school IS charged, the
// payment row stays PENDING, currentPeriodEnd is never extended, and dunning
// then flips them PAST_DUE and downgrades them to STANDARD. A school pays for
// ENTERPRISE and gets demoted for it, with nothing connecting the two events.
// =============================================================================

import { PaymentReconciliationService } from "../../src/fees/reconciliation.service";

const SCHOOL = "11111111-1111-1111-1111-111111111111";

function makeSweep(charges: Array<Record<string, unknown>>, recover = jest.fn().mockResolvedValue(true)) {
  const svc = Object.create(PaymentReconciliationService.prototype) as PaymentReconciliationService;
  const listSettled = jest.fn().mockResolvedValue(charges);
  Object.assign(svc, {
    logger: { log: jest.fn(), warn: jest.fn() },
    paystack: { isConfigured: () => true, listSuccessfulTransactions: listSettled },
    stripe: { isConfigured: () => false, listRecentPaidSessions: jest.fn().mockResolvedValue([]) },
    privileged: { client: { payment: { findMany: jest.fn().mockResolvedValue([]) }, user: { findMany: jest.fn().mockResolvedValue([]) } } },
    settlement: { applyOnlinePayment: jest.fn().mockResolvedValue("posted") },
    billing: { recoverSubscriptionCharge: recover },
    notifications: { enqueue: jest.fn() },
    db: { runAsTenant: jest.fn(async (_c: unknown, fn: (t: unknown) => unknown) => fn({})) },
    audit: { record: jest.fn() },
  });
  return { svc, recover };
}

const subCharge = {
  reference: "SUB-abc-123",
  amountMinor: 250_000,
  currency: "NGN",
  metadata: { kind: "subscription", schoolId: SCHOOL },
  note: "Online (Paystack)",
};

describe("subscription reconciliation", () => {
  afterEach(() => jest.restoreAllMocks());

  it("RECOVERS a subscription charge whose webhook never arrived", async () => {
    const { svc, recover } = makeSweep([subCharge]);
    const r = await svc.sweep("SCHEDULED");
    expect(recover).toHaveBeenCalledWith(SCHOOL, "SUB-abc-123", { amountMinor: 250_000, currency: "NGN" });
    expect(r).toMatchObject({ subscriptionCharges: 1, subscriptionRecovered: 1 });
  });

  it("counts a charge it saw but did not need to recover", async () => {
    // Already PAID — the webhook did arrive. Seen, not recovered.
    const { svc } = makeSweep([subCharge], jest.fn().mockResolvedValue(false));
    const r = await svc.sweep("SCHEDULED");
    expect(r).toMatchObject({ subscriptionCharges: 1, subscriptionRecovered: 0 });
  });

  it("one school's bad row does not stop the sweep reaching the others", async () => {
    const recover = jest
      .fn()
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValueOnce(true);
    const { svc } = makeSweep(
      [subCharge, { ...subCharge, reference: "SUB-def-456" }],
      recover,
    );
    const r = await svc.sweep("SCHEDULED");
    expect(recover).toHaveBeenCalledTimes(2);
    expect(r.subscriptionRecovered).toBe(1);
  });

  it("ignores a subscription charge carrying no school", async () => {
    // Nothing to scope the write to, and guessing a tenant is never acceptable.
    const { svc, recover } = makeSweep([{ ...subCharge, metadata: { kind: "subscription" } }]);
    const r = await svc.sweep("SCHEDULED");
    expect(recover).not.toHaveBeenCalled();
    expect(r.subscriptionCharges).toBe(0);
  });

  it("still recovers INVOICE charges — this is an addition, not a replacement", async () => {
    const invoiceCharge = {
      reference: "PAY-xyz-789",
      amountMinor: 50_000,
      currency: "NGN",
      metadata: { kind: "invoice", invoiceId: "inv-1", schoolId: SCHOOL },
      note: "Online (Paystack)",
    };
    const { svc } = makeSweep([subCharge, invoiceCharge]);
    const r = await svc.sweep("SCHEDULED");
    expect(r).toMatchObject({ subscriptionCharges: 1, invoiceCharges: 1, posted: 1 });
  });
});
