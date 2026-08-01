// =============================================================================
// Mobile money — recovery when the callback never came
// =============================================================================
// A mobile-money callback is unsigned, delivered ONCE on a best-effort basis, and
// is the only thing that tells us a payment succeeded. Lose one to a deploy, a
// 5xx or a network blip and the payer has been debited while the invoice stays
// open forever.
//
// The card rails have had a reconciliation sweep for exactly this since the
// payments-completion program. Mobile money — the LESS reliable rail, on the
// continent where most fees are paid — had none. No contract test would ever have
// found that: every wire assertion passed, because the wire was never the problem.
//
// The properties that matter here are about NOT guessing:
//   • "we do not know" leaves the charge PENDING and asks again later;
//   • a charge nobody can answer for is EXPIRED, never quietly failed or paid;
//   • recovery and the callback share ONE settle path, so they cannot disagree;
//   • one rail being down does not stop the sweep for the others.
// =============================================================================

import { MobileMoneyService } from "../../src/payments/mobile-money.service";
import type { TenantContext, TenantTx } from "../../src/integrity/integrity.foundation";

const SCHOOL = "s-1";
const HOUR = 3_600_000;

const INTENT = {
  id: "i-1",
  schoolId: SCHOOL,
  reference: "MM-ABC123",
  provider: "MPESA",
  invoiceId: "inv-1",
  amountMinor: 50_000,
  currency: "KES",
  payerId: "u-1",
  status: "PENDING",
  providerRef: "ws_CO_1",
  createdAt: new Date(Date.now() - HOUR),
};

function makeService(over: Record<string, unknown> = {}) {
  const updates: Array<Record<string, unknown>> = [];
  const tx = {
    mobileMoneyIntent: {
      update: jest.fn(async ({ data }: { data: Record<string, unknown> }) => {
        updates.push(data);
        return data;
      }),
      findFirst: jest.fn().mockResolvedValue(null),
      create: jest.fn(),
    },
    invoice: { findFirst: jest.fn() },
    payment: { aggregate: jest.fn() },
  } as unknown as TenantTx;

  const db = {
    runAsTenant: <T>(_c: TenantContext, fn: (t: TenantTx) => Promise<T>) => fn(tx),
    runAsTenantReadOnly: <T>(_c: TenantContext, fn: (t: TenantTx) => Promise<T>) => fn(tx),
  };
  const region = { forSchool: jest.fn().mockResolvedValue({ country: "KE" }) };
  const settlement = { applyOnlinePayment: jest.fn().mockResolvedValue((over.settleOutcome as string) ?? "posted") };
  const events = { record: jest.fn() };

  const pendingRows = (over.pending as unknown[]) ?? [];
  const privileged = {
    client: over.noPrivileged
      ? null
      : { mobileMoneyIntent: { findMany: jest.fn().mockResolvedValue(pendingRows), findFirst: jest.fn() } },
  };

  const getStatus = jest.fn().mockResolvedValue(
    (over.reading as unknown) ?? { reference: "MM-ABC123", outcome: "SUCCEEDED", providerRef: "ws_CO_1" },
  );
  const rail = (key: string, configured = true) => ({
    key,
    wholeUnitsOnly: false,
    isConfigured: () => configured,
    charge: jest.fn(),
    readCallback: jest.fn(),
    getStatus: key === "MPESA" ? getStatus : jest.fn().mockResolvedValue({ reference: null, outcome: "PENDING" }),
  });

  const svc = new MobileMoneyService(
    db as never, region as never, settlement as never, events as never, privileged as never,
    rail("MPESA", over.mpesaConfigured !== false) as never,
    rail("MTN_MOMO", false) as never,
    rail("AIRTEL", false) as never,
  );
  return { svc, settlement, events, updates, getStatus, privileged };
}

describe("recoverPending — the sweep the card rails always had", () => {
  it("settles a charge whose callback never arrived", async () => {
    // The whole point. The payer was debited an hour ago; nothing ever told us.
    const { svc, settlement } = makeService({ pending: [INTENT] });
    const r = await svc.recoverPending("SCHEDULED");
    expect(r).toMatchObject({ scanned: 1, settled: 1, failed: 0, stillPending: 0, expired: 0 });
    expect(settlement.applyOnlinePayment).toHaveBeenCalledWith(
      expect.objectContaining({
        invoiceId: "inv-1",
        creditMinor: 50_000, // OUR recorded figure, never the rail's
        currency: "KES",
        reference: "MM-ABC123",
      }),
    );
  });

  it("uses the SAME settle path as the callback, so the two cannot disagree", async () => {
    // A sweep that reimplemented settlement would be a second posting path —
    // exactly what InvoiceSettlementService exists to prevent.
    const { svc, settlement, updates } = makeService({ pending: [INTENT] });
    await svc.recoverPending("MANUAL");
    expect(settlement.applyOnlinePayment).toHaveBeenCalledTimes(1);
    expect(updates.some((u) => u.status === "SUCCEEDED" && u.settledAt)).toBe(true);
  });

  it("leaves a still-unknown charge PENDING and posts nothing", async () => {
    // "We do not know" is not an outcome. Settling or failing on it is one-way.
    const { svc, settlement, updates } = makeService({
      pending: [INTENT],
      reading: { reference: "MM-ABC123", outcome: "PENDING" },
    });
    const r = await svc.recoverPending("SCHEDULED");
    expect(r).toMatchObject({ stillPending: 1, settled: 0, failed: 0 });
    expect(settlement.applyOnlinePayment).not.toHaveBeenCalled();
    expect(updates).toHaveLength(0);
  });

  it("records a rail-confirmed failure without touching the ledger", async () => {
    const { svc, settlement, updates } = makeService({
      pending: [INTENT],
      reading: { reference: "MM-ABC123", outcome: "FAILED", failureReason: "Request cancelled by user" },
    });
    const r = await svc.recoverPending("SCHEDULED");
    expect(r).toMatchObject({ failed: 1, settled: 0 });
    expect(settlement.applyOnlinePayment).not.toHaveBeenCalled();
    expect(updates[0]).toMatchObject({ status: "FAILED", failureReason: "Request cancelled by user" });
  });

  it("EXPIRES a charge too old to ask about, without ever polling it", async () => {
    // Rails do not keep a charge queryable forever; past that they answer
    // "unknown", which reads as PENDING and would circulate the intent for life.
    // EXPIRED, not FAILED — the rail never said it failed, we stopped asking, and
    // whoever reconciles it needs to know money may still have moved.
    const old = { ...INTENT, createdAt: new Date(Date.now() - 10 * 24 * HOUR) };
    const { svc, updates, getStatus, settlement } = makeService({ pending: [old] });
    const r = await svc.recoverPending("SCHEDULED");
    expect(r).toMatchObject({ expired: 1, settled: 0, failed: 0 });
    expect(getStatus).not.toHaveBeenCalled();
    expect(settlement.applyOnlinePayment).not.toHaveBeenCalled();
    expect(updates[0]).toMatchObject({ status: "EXPIRED" });
    expect(String(updates[0].failureReason)).toMatch(/before paying again/);
  });

  it("does NOT chase a charge the payer may still be approving", async () => {
    // The handset prompt is live for minutes. Polling a fresh charge just races
    // the payer, so the query is windowed — asserted on the query itself.
    const { svc, privileged } = makeService({ pending: [] });
    await svc.recoverPending("SCHEDULED");
    const where = (privileged.client!.mobileMoneyIntent.findMany as jest.Mock).mock.calls[0][0].where;
    expect(where.status).toBe("PENDING");
    expect(where.createdAt.lt.getTime()).toBeLessThan(Date.now());
    expect(Date.now() - where.createdAt.lt.getTime()).toBeGreaterThanOrEqual(3 * 60_000);
  });

  it("keeps going when ONE rail is down", async () => {
    // A provider outage must not stall recovery for every other school.
    const { svc } = makeService({ pending: [INTENT, { ...INTENT, id: "i-2", reference: "MM-DEF456" }] });
    const svc2 = svc as unknown as { providers: Map<string, { getStatus: jest.Mock }> };
    svc2.providers.get("MPESA")!.getStatus
      .mockRejectedValueOnce(new Error("gateway timeout"))
      .mockResolvedValueOnce({ reference: "MM-DEF456", outcome: "SUCCEEDED" });
    const r = await svc.recoverPending("SCHEDULED");
    expect(r).toMatchObject({ scanned: 2, stillPending: 1, settled: 1 });
  });

  it("refuses to mark an intent settled when settlement rejected the currency", async () => {
    // Money moved that we are declining to post. If the intent read as SUCCEEDED,
    // nothing would ever revisit it.
    const { svc, updates } = makeService({ pending: [INTENT], settleOutcome: "currency_mismatch" });
    await svc.recoverPending("SCHEDULED");
    expect(updates[0]).toMatchObject({ status: "FAILED" });
    expect(String(updates[0].failureReason)).toMatch(/manual reconciliation/i);
  });

  it("EXPIRES an ancient charge even on a rail that is no longer configured", async () => {
    // Otherwise the intents least likely to ever resolve — on a decommissioned
    // rail — are the only ones that stay PENDING for ever.
    const old = { ...INTENT, createdAt: new Date(Date.now() - 10 * 24 * HOUR) };
    const { svc, updates } = makeService({ pending: [old], mpesaConfigured: false });
    const r = await svc.recoverPending("SCHEDULED");
    expect(r).toMatchObject({ expired: 1 });
    expect(updates[0]).toMatchObject({ status: "EXPIRED" });
  });

  it("skips a rail with no credentials rather than erroring", async () => {
    const { svc, settlement } = makeService({ pending: [INTENT], mpesaConfigured: false });
    const r = await svc.recoverPending("SCHEDULED");
    expect(r).toMatchObject({ scanned: 1, settled: 0 });
    expect(settlement.applyOnlinePayment).not.toHaveBeenCalled();
  });

  it("is inert without the privileged client, and says so", async () => {
    const { svc } = makeService({ noPrivileged: true });
    await expect(svc.recoverPending("SCHEDULED")).resolves.toMatchObject({ scanned: 0, settled: 0 });
  });

  it("never re-settles an intent that is no longer PENDING", async () => {
    // Belt and braces with the query filter: a callback can land between the read
    // and the poll, and settlement's own reference idempotency is the third layer.
    const { svc, settlement } = makeService({ pending: [{ ...INTENT, status: "SUCCEEDED" }] });
    await svc.recoverPending("SCHEDULED");
    expect(settlement.applyOnlinePayment).not.toHaveBeenCalled();
  });
});
