// =============================================================================
// Money kept arriving for schools that had been switched off
// =============================================================================
// DISABLED is the hard lever: nobody at the school can sign in, the guard
// refuses every authenticated request, a rolling session is revoked, and the
// login page says what happened. Two things went on regardless.
//
// MONEY. A checkout opened before the switch was thrown still calls back, and a
// dedicated NUBAN transfer needs no session at all — a parent can pay into it at
// any hour. Every one of those posted to a ledger nobody could open, marked an
// invoice PAID that nobody could see, and sent a receipt in the name of a school
// that could not answer the telephone.
//
// WORDS. The fee-reminder and late-fee sweeps had already been stopped for
// exactly this reason — "emailing them about the balance IN THE SCHOOL'S NAME
// while nobody there could sign in to see it, stop it, or answer a parent who
// rang" — but that was two sweeps, not the rule. An overdue-boarder alert, a
// chargeback warning to finance and a document-expiry reminder to HR all still
// went out.
//
// Both are fixed at a FUNNEL rather than at the producers: settlement is the one
// posting path for every rail, and `persist` is the one place a notification
// decides its external channels. The alternative is a rule that has to be
// remembered at seven call sites and forty producers.
//
// WHAT IS DELIBERATELY NOT SUPPRESSED: the in-app inbox row. Disabling deletes
// nothing and reinstatement is total, so the notices a school missed are part of
// its "original and due state" — and they are unreadable meanwhile because
// nobody can sign in. Suppressing the record too would make the switch
// destructive, which is the one thing it is not.
//
// AND THE MONEY IS NOT SILENTLY SWALLOWED. The payer has been debited. Refusing
// to post is recoverable only because somebody is told: the refusal logs at
// ERROR and alerts the platform owner by name, amount and gateway reference, so
// the choice between reinstating the school and refunding the payer reaches a
// person. No sweep will do it — reconciliation looks back three days and a
// suspension lasts as long as it lasts.
// =============================================================================

import { InvoiceSettlementService } from "../../src/fees/settlement.service";
import type { TenantContext, TenantTx } from "../../src/integrity/integrity.foundation";

const SCHOOL = "1e7f0a4c-0000-4000-8000-000000000001";
const INVOICE = "1e7f0a4c-0000-4000-8000-000000000002";

function make(active: boolean) {
  const created: Array<Record<string, unknown>> = [];
  const tx = {
    invoice: {
      findFirst: jest.fn().mockResolvedValue({
        id: INVOICE, currency: "NGN", totalMinor: 1_000_000, status: "ISSUED", createdById: "staff-1", studentId: "pupil-1",
      }),
      update: jest.fn().mockResolvedValue({}),
    },
    payment: {
      create: jest.fn(({ data }: { data: Record<string, unknown> }) => {
        created.push(data);
        return Promise.resolve({ id: "pay-1", ...data });
      }),
      findFirst: jest.fn().mockResolvedValue(null),
      findMany: jest.fn().mockResolvedValue([{ amountMinor: 500_000, kind: "PAYMENT" }]),
    },
    parentChild: { findMany: jest.fn().mockResolvedValue([]) },
    userRole: { findMany: jest.fn().mockResolvedValue([]) },
    school: { findFirst: jest.fn().mockResolvedValue({ paystackSubaccountCode: "ACCT_test", name: "St Andrews", status: active ? "ACTIVE" : "DISABLED" }) },
    user: { findMany: jest.fn().mockResolvedValue([{ id: "owner-1", schoolId: "PLATFORM" }]) },
  } as unknown as TenantTx;

  const db = { runAsTenant: <T>(_c: TenantContext, fn: (t: TenantTx) => Promise<T>) => fn(tx) };
  const audit = { record: jest.fn().mockResolvedValue(undefined) };
  const notifications = { enqueue: jest.fn().mockResolvedValue(undefined) };
  const errors: string[] = [];
  const privileged = {
    client: {
      school: { findFirst: jest.fn().mockResolvedValue({ name: "St Andrews", status: "DISABLED" }) },
      user: { findMany: jest.fn().mockResolvedValue([{ id: "owner-1", schoolId: "PLATFORM" }]) },
    },
  };
  const svc = new InvoiceSettlementService(
    db as never,
    audit as never,
    notifications as never,
    { isActive: async () => active } as never,
    privileged as never,
  );
  (svc as unknown as { logger: unknown }).logger = { log: jest.fn(), warn: jest.fn(), error: (m: string) => errors.push(m) };
  return { svc, tx, created, notifications, errors };
}

const charge = {
  schoolId: SCHOOL,
  invoiceId: INVOICE,
  creditMinor: 250_000,
  currency: "NGN",
  chargedMinor: 250_000,
  reference: "PSK_abc123",
  note: "Paystack card payment",
};

describe("a charge that arrives for a school that has been switched off", () => {
  it("is not posted", async () => {
    const t = make(false);
    await expect(t.svc.applyOnlinePayment(charge)).resolves.toBe("school_disabled");
    expect(t.created).toHaveLength(0);
  });

  it("does not touch the invoice either", async () => {
    // Settlement WRITES a status over whatever the invoice had. Posting here
    // would not merely record money oddly, it would move the invoice.
    const t = make(false);
    await t.svc.applyOnlinePayment(charge);
    expect(t.tx.invoice.update).not.toHaveBeenCalled();
  });

  it("is refused before the invoice is even read", async () => {
    // The school's status is a fact about the school, not about the invoice.
    // Checking it first also means a suspended school costs one cached lookup
    // rather than a transaction.
    const t = make(false);
    await t.svc.applyOnlinePayment(charge);
    expect(t.tx.invoice.findFirst).not.toHaveBeenCalled();
  });

  it("does NOT throw, so the rail still gets its 2xx", async () => {
    // A non-2xx makes a gateway retry for days, and retrying will not make the
    // school active. Refusing to post is the whole of the refusal.
    const t = make(false);
    await expect(t.svc.applyOnlinePayment(charge)).resolves.toBeDefined();
  });
});

describe("what happens to money nobody may post", () => {
  it("logs at ERROR with the reference, the amount and what to do", async () => {
    const t = make(false);
    await t.svc.applyOnlinePayment(charge);
    expect(t.errors).toHaveLength(1);
    expect(t.errors[0]).toMatch(/PSK_abc123/);
    expect(t.errors[0]).toMatch(/250000/);
    expect(t.errors[0]).toMatch(/Reinstate the school or refund the payer/);
  });

  it("alerts the platform owner, who is the only one who can act", async () => {
    // Nobody at the school can sign in, so the school cannot be told; and
    // nothing revisits this — the reconciliation sweep looks back three days.
    const t = make(false);
    await t.svc.applyOnlinePayment(charge);
    const call = t.notifications.enqueue.mock.calls[0];
    expect(call[0]).toMatchObject({ schoolId: "PLATFORM", userId: "owner-1" });
    expect(call[1]).toMatchObject({ type: "OPERATOR_ALERT", recipientId: "owner-1" });
    expect(call[1].body).toMatch(/HAS been debited/);
    expect(call[1].body).toMatch(/PSK_abc123/);
  });

  it("says the payer was debited, not that a payment failed", async () => {
    // The distinction is the whole point: the charge succeeded at the gateway.
    const t = make(false);
    await t.svc.applyOnlinePayment(charge);
    const body = t.notifications.enqueue.mock.calls[0][1].body as string;
    expect(body).toMatch(/refund the payment on the gateway/);
    expect(body).not.toMatch(/failed/i);
  });
});

describe("a school that is switched ON is untouched", () => {
  it("posts exactly as before", async () => {
    const t = make(true);
    await expect(t.svc.applyOnlinePayment(charge)).resolves.toBe("posted");
    expect(t.created).toHaveLength(1);
    expect(t.created[0]).toMatchObject({ amountMinor: 250_000, status: "POSTED", reference: "PSK_abc123" });
  });

  it("and raises no operator alert", async () => {
    const t = make(true);
    await t.svc.applyOnlinePayment(charge);
    const alerts = t.notifications.enqueue.mock.calls.filter((c) => c[1]?.type === "OPERATOR_ALERT");
    expect(alerts).toHaveLength(0);
    expect(t.errors).toHaveLength(0);
  });
});
