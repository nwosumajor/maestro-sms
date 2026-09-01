// =============================================================================
// A naira award posted onto an invoice in any currency at all
// =============================================================================
// A scholarship is funded by the PLATFORM, so `awardMinor` is a platform figure
// in kobo — the operator console's input helper was literally called
// `nairaToKobo`. The invoice it lands on belongs to a SCHOOL, and
// `school.currency` is a free-form ISO code: any of the twenty-nine in the
// catalogue. `disburseFeesCredit` never compared the two.
//
// An award of ₦50,000 is 5,000,000 kobo. Posted against:
//
//   a GBP invoice   ->  £50,000 credited
//   a GHS invoice   ->  GHS 50,000 credited
//   an XOF invoice  ->  5,000,000 francs credited (a franc has no minor unit)
//
// In each case the family's fees are cleared or hugely over-credited, the
// invoice is marked PAID, and the platform's own books record that it granted
// fifty thousand naira. Nothing revisits a settled invoice, so nothing would
// ever have found it.
//
// The platform ALREADY has this guard, one module away:
// `InvoiceSettlementService.applyOnlinePayment` takes a REQUIRED currency and
// compares it to the invoice BEFORE posting, precisely because a refusal leaves
// the invoice OPEN and is recoverable while a posting is not. Scholarship
// disbursement is a second posting path that never asked.
//
// The REVERSAL is deliberately untouched and a test pins why: it reads its
// amount off the credit payment row itself, on the same invoice, so it cannot
// disagree with the thing it reverses.
//
// The second defect here is the sentence: the family was told "the award has
// been credited against the student's school fees" whether or not anything
// posted.
// =============================================================================

import { ScholarshipAdminService } from "../../src/scholarship/scholarship-admin.service";

const P = { schoolId: "PLAT", userId: "owner-1", roles: ["super_admin"], permissions: ["scholarship.admin"] } as never;

function make(invoiceCurrency: string | null) {
  const paymentCreate = jest.fn().mockResolvedValue({ id: "pay-1" });
  const db = {
    scholarshipApplication: {
      findFirst: jest.fn().mockResolvedValue({
        id: "app-1", schoolId: "s1", studentId: "pupil-1", programId: "prog-1", status: "QUALIFIED",
      }),
      findMany: jest.fn().mockResolvedValue([]),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      update: jest.fn().mockResolvedValue({}),
      groupBy: jest.fn().mockResolvedValue([]),
    },
    scholarshipProgram: {
      findFirst: jest.fn().mockResolvedValue({
        title: "Prog", awardMinor: 5_000_000, award2Minor: null, award3Minor: null,
        awardKind: "FEES_CREDIT", budgetMinor: 0,
      }),
    },
    // Every real privileged client has this, and the award now grants the
    // winner's SCHOOL a prize through it. A stub without one models a database
    // that cannot exist, and its absence surfaced here as a SECOND error line
    // in a suite counting them.
    schoolSubscription: {
      findFirst: jest.fn().mockResolvedValue({ id: "sub-1", grantedUntil: null }),
      update: jest.fn().mockResolvedValue({}),
    },
    invoice: {
      findFirst: jest.fn().mockResolvedValue(
        invoiceCurrency === null
          ? null
          : { id: "inv-1", totalMinor: 9_000_000, currency: invoiceCurrency, payments: [] },
      ),
      update: jest.fn().mockResolvedValue({}),
    },
    payment: { create: paymentCreate, findMany: jest.fn().mockResolvedValue([]) },
    // Every real privileged client can reach the credit ledger; an award with
    // no open invoice is now held there rather than given up on.
    studentCreditEntry: {
      findFirst: jest.fn().mockResolvedValue(null),
      create: jest.fn().mockImplementation(({ data }: { data: Record<string, unknown> }) =>
        Promise.resolve({ id: "credit-1", ...data }),
      ),
    },
    school: { findFirst: jest.fn().mockResolvedValue({ currency: invoiceCurrency ?? "NGN" }) },
  };
  const s = Object.create(ScholarshipAdminService.prototype) as ScholarshipAdminService;
  const errors: string[] = [];
  Object.assign(s, {
    // The entitlement cache, dropped when a school prize is granted.
    modules: { invalidate: jest.fn() },
    privileged: { client: db },
    notifications: {},
    audit: { record: jest.fn() },
    logger: { log: jest.fn(), warn: jest.fn(), error: (m: string) => errors.push(m) },
  });
  (s as unknown as { client: unknown }).client = () => db;
  const auditOwn = jest.fn().mockResolvedValue(undefined);
  const notifyFamily = jest.fn().mockResolvedValue(undefined);
  (s as unknown as { auditOwn: unknown }).auditOwn = auditOwn;
  (s as unknown as { notifyFamily: unknown }).notifyFamily = notifyFamily;
  (s as unknown as { listApplicationById: unknown }).listApplicationById = jest.fn().mockResolvedValue([{ id: "app-1" }]);
  return { s, db, paymentCreate, auditOwn, notifyFamily, errors };
}

const award = (s: ScholarshipAdminService) => s.decide(P, "app-1", { action: "AWARD", position: 1 });

describe("posting a platform award onto a school's invoice", () => {
  it("posts when the invoice is in the award's own currency", async () => {
    const t = make("NGN");
    await award(t.s);
    expect(t.paymentCreate).toHaveBeenCalledTimes(1);
    expect(t.paymentCreate.mock.calls[0][0].data).toMatchObject({ amountMinor: 5_000_000, kind: "SCHOLARSHIP" });
  });

  it("posts NOTHING when the invoice is in another currency", async () => {
    // £50,000, silently, off a ₦50,000 award.
    const t = make("GBP");
    await award(t.s);
    expect(t.paymentCreate).not.toHaveBeenCalled();
  });

  it("refuses BEFORE the write, so the invoice is left exactly as it was", async () => {
    // The order is the whole point: a refusal is recoverable, a posting is not.
    const t = make("XOF");
    await award(t.s);
    expect(t.paymentCreate).not.toHaveBeenCalled();
    expect(t.db.invoice.update).not.toHaveBeenCalled();
  });

  it("still refuses for a zero-decimal currency, where the error is largest", async () => {
    const t = make("XOF");
    await award(t.s);
    expect(t.paymentCreate).not.toHaveBeenCalled();
  });

  it("does not refuse the award itself — only the posting", async () => {
    // The decision stands and can be disbursed by hand; refusing the award
    // would throw away a decision the platform owner legitimately made.
    const t = make("GBP");
    await expect(award(t.s)).resolves.toBeDefined();
    expect(t.db.scholarshipApplication.updateMany).toHaveBeenCalled();
  });
});

describe("what anyone is told about it", () => {
  it("logs at ERROR, naming both currencies and what to do", async () => {
    // Nothing else notices: no sweep revisits a settled invoice and no screen
    // shows an award that failed to post.
    const t = make("GBP");
    await award(t.s);
    expect(t.errors).toHaveLength(1);
    expect(t.errors[0]).toMatch(/GBP/);
    expect(t.errors[0]).toMatch(/NGN/);
    expect(t.errors[0]).toMatch(/manually/i);
  });

  it("records WHY nothing posted in the audit row, not just that nothing did", async () => {
    // "disbursed: 0" is the same entry for a family with no open invoice and
    // for an award refused over a currency, and only one needs somebody to act.
    const t = make("GBP");
    await award(t.s);
    expect(t.auditOwn.mock.calls[0][3]).toMatchObject({ disbursed: 0, notDisbursedReason: "currency_mismatch" });
  });

  it("distinguishes that from simply having no open invoice", async () => {
    // NO OPEN INVOICE IS NO LONGER A DEAD END. This asserted `disbursed: 0`
    // with `no_open_invoice`, which was the defect: the award stood, nothing
    // posted and nothing ever retried. It now goes to the pupil's CREDIT
    // LEDGER — the mechanism a dedicated-account transfer already uses when
    // there is no invoice to settle — so the money reaches the family and the
    // audit row says where it went.
    const t = make(null);
    await award(t.s);
    expect(t.auditOwn.mock.calls[0][3]).toMatchObject({ disbursed: 5_000_000, disbursedTo: "CREDIT" });
    expect(t.errors).toHaveLength(0); // not an incident: it was disbursed
  });

  it("tells the family the money moved only when it did", async () => {
    const paid = make("NGN");
    await award(paid.s);
    expect(paid.notifyFamily.mock.calls[0][4]).toMatch(/has been credited/);

    const notPaid = make("GBP");
    await award(notPaid.s);
    expect(notPaid.notifyFamily.mock.calls[0][4]).not.toMatch(/has been credited/);
    expect(notPaid.notifyFamily.mock.calls[0][4]).toMatch(/will apply it/);
  });

  it("still congratulates them either way", async () => {
    // The award is real news whether or not the credit has landed; the fix is
    // to stop asserting a balance change, not to make the message grudging.
    const t = make("GBP");
    await award(t.s);
    expect(t.notifyFamily.mock.calls[0][4]).toMatch(/Congratulations/);
  });
});
