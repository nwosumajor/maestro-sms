// =============================================================================
// Verify on return — the school is back from the gateway, settle now
// =============================================================================
// OBSERVED, on a real purchase: a school bought five years, Paystack reported
// `success` and took NGN 231,581.25, and the payment history said "Awaiting
// payment" with the plan unchanged. The subscription checkout carried no
// callback_url at all, so the whole flow depended on a webhook arriving — and
// none had.
//
// Parent fee payments have verified on return for a long time. The school's OWN
// subscription, the larger transaction, had nothing. This closes that.
//
// The properties that matter are about NOT making it worse: settling through
// the same idempotent path the webhook uses, never double-extending a period,
// and never telling a school who HAS paid that their payment failed.
// =============================================================================

import { NotFoundException } from "@nestjs/common";
import { BillingService } from "../../src/billing/billing.service";

const SCHOOL = "62a0e3a3-0000-0000-0000-000000000000";
const principal = { userId: "u-1", schoolId: SCHOOL, roles: ["school_admin"], permissions: [] } as never;

function makeService(opts: { rowStatus?: string | null; verified?: { status: string } | null }) {
  const statuses = [opts.rowStatus, "PAID"]; // before, then after applying
  let call = 0;
  const findFirst = jest.fn(async () => {
    const s = statuses[Math.min(call++, statuses.length - 1)];
    return s == null ? null : { id: "pay-1", status: s, schoolId: SCHOOL };
  });
  const verifyTransaction = jest.fn().mockResolvedValue(
    opts.verified === undefined ? { status: "success", amountMinor: 23_158_125, currency: "NGN" } : opts.verified,
  );
  const applyPaidByReference = jest.fn().mockResolvedValue({ ok: true });
  const svc = Object.create(BillingService.prototype) as BillingService;
  Object.assign(svc, {
    db: { runAsTenant: jest.fn(async (_c: unknown, fn: (t: unknown) => unknown) => fn({ platformSubscriptionPayment: { findFirst } })) },
    paystack: { verifyTransaction },
    applyPaidByReference,
  });
  jest.spyOn(svc, "getStatus").mockResolvedValue({ plan: "ENTERPRISE", currentPeriodEnd: new Date() } as never);
  return { svc, verifyTransaction, applyPaidByReference, findFirst };
}

describe("verify on return", () => {
  afterEach(() => jest.restoreAllMocks());

  it("settles a payment the gateway confirms but no webhook delivered", async () => {
    const { svc, applyPaidByReference } = makeService({ rowStatus: "PENDING" });
    const out = await svc.verifyPayment(principal, "SUB-62a0e3a3-1786342132387");
    expect(applyPaidByReference).toHaveBeenCalled();
    expect(out.settled).toBe(true);
  });

  it("settles through the SAME path the webhook uses", async () => {
    // Not a second posting route. It takes the same row lock and the same
    // idempotency guard, so a webhook arriving afterwards cannot extend the
    // period a second time.
    const { svc, applyPaidByReference } = makeService({ rowStatus: "PENDING" });
    await svc.verifyPayment(principal, "REF");
    expect(applyPaidByReference).toHaveBeenCalledWith(SCHOOL, "REF", {
      amountMinor: 23_158_125,
      currency: "NGN",
    });
  });

  it("does NOT re-apply a payment already settled", async () => {
    // The webhook won the race. Verifying must be a no-op, not a second credit.
    const { svc, verifyTransaction, applyPaidByReference } = makeService({ rowStatus: "PAID" });
    const out = await svc.verifyPayment(principal, "REF");
    expect(verifyTransaction).not.toHaveBeenCalled();
    expect(applyPaidByReference).not.toHaveBeenCalled();
    expect(out.settled).toBe(true);
  });

  it("does not settle when the gateway does NOT confirm the charge", async () => {
    // An abandoned checkout must not become a paid subscription just because
    // somebody re-opened the return URL.
    const { svc, applyPaidByReference } = makeService({
      rowStatus: "PENDING",
      verified: { status: "abandoned" },
    });
    Object.assign(svc, { db: { runAsTenant: jest.fn(async (_c: unknown, fn: (t: unknown) => unknown) => fn({ platformSubscriptionPayment: { findFirst: jest.fn().mockResolvedValue({ id: "p", status: "PENDING", schoolId: SCHOOL }) } })) } });
    const out = await svc.verifyPayment(principal, "REF");
    expect(applyPaidByReference).not.toHaveBeenCalled();
    expect(out.settled).toBe(false);
  });

  it("404s a reference that is not this school's", async () => {
    // Never disclose that a reference exists in another tenant.
    const { svc } = makeService({ rowStatus: null });
    await expect(svc.verifyPayment(principal, "SOMEONE-ELSE")).rejects.toBeInstanceOf(NotFoundException);
  });

  it("returns the subscription so the page can show the NEW PERIOD", async () => {
    // "Paid" is a receipt. "Covered until…" is the answer the school came back
    // with, and it is the whole point of buying multiple periods.
    const { svc } = makeService({ rowStatus: "PENDING" });
    const out = await svc.verifyPayment(principal, "REF");
    expect(out.subscription).toBeDefined();
    expect(out.subscription.currentPeriodEnd).toBeDefined();
  });
});

describe("the checkout brings the school back", () => {
  it("sends a callback_url on BOTH subscription checkout paths", async () => {
    // The defect was the absence of one: with no return URL the flow had no
    // path to settlement except the webhook.
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const src = readFileSync(join(__dirname, "../../src/billing/billing.service.ts"), "utf8");
    const hits = src.match(/callbackUrl: `\$\{process\.env\.PUBLIC_WEB_URL/g) ?? [];
    expect(hits.length).toBe(2);
    expect(src).toContain("/billing?verify=");
  });
});

describe("a payment never shortens a period already paid for", () => {
  it("is the invariant the settlement code states and enforces", async () => {
    // OBSERVED on a real purchase. A school bought five years — the period was
    // correctly set to 2030-05-10 — and a NGN 10,331 term charge settled 67ms
    // later, flagged UPGRADE because it too had been started from the old plan.
    // It restarted the period from now and left them with three months, having
    // paid NGN 241,912.
    //
    // Taking the LATER of the two dates makes the outcome independent of the
    // order webhooks and the reconciliation sweep happen to arrive in.
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const src = readFileSync(join(__dirname, "../../src/billing/billing.service.ts"), "utf8");
    const guard = src.indexOf("sub?.currentPeriodEnd && sub.currentPeriodEnd > computedEnd");
    expect(guard).toBeGreaterThan(-1);
    // and it must be what is WRITTEN, not merely computed and discarded
    expect(src).toMatch(/const periodEnd =\s*\n?\s*sub\?\.currentPeriodEnd/);
  });

  it("pure check: the later date always wins, whichever way round they arrive", () => {
    const pick = (computed: Date, current: Date | null) =>
      current && current > computed ? current : computed;
    const long = new Date("2030-05-10");
    const short = new Date("2026-11-10");
    // 5-year first, then the term charge — the real ordering that broke it
    expect(pick(short, long)).toEqual(long);
    // and the reverse ordering, which must reach the same place
    expect(pick(long, short)).toEqual(long);
    // a genuine first purchase still sets its own period
    expect(pick(short, null)).toEqual(short);
  });
});
