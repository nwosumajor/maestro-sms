// =============================================================================
// Held funds — money the platform is sitting on, and whether anyone knows
// =============================================================================
// When a school has no settlement subaccount, a Paystack split has nowhere to
// go and the WHOLE charge stays in the platform's account. The invoice is still
// correctly PAID — the parent did pay — so every screen in this system agreed
// the school had been paid, while the cash was somewhere else and nothing
// anywhere recorded the debt.
//
// The property under test is that the answer is a SNAPSHOT. Derived from
// current state it would be a lie: the day a school registers a bank, every
// historical payment would silently stop being owed.
// =============================================================================

import { InvoiceSettlementService } from "../../src/fees/settlement.service";

const SCHOOL = "11111111-1111-1111-1111-111111111111";
const INVOICE = "22222222-2222-2222-2222-222222222222";

function makeService(opts: { subaccount?: string | null }) {
  const created: Array<Record<string, unknown>> = [];
  const tx = {
    invoice: {
      findFirst: jest.fn().mockResolvedValue({
        id: INVOICE,
        schoolId: SCHOOL,
        currency: "NGN",
        totalMinor: 50_000,
        status: "ISSUED",
        createdById: "u-creator",
      }),
      update: jest.fn().mockResolvedValue({}),
    },
    school: { findFirst: jest.fn().mockResolvedValue({ paystackSubaccountCode: opts.subaccount ?? null }) },
    payment: {
      findFirst: jest.fn().mockResolvedValue(null), // not a duplicate
      create: jest.fn(async (args: { data: Record<string, unknown> }) => {
        created.push(args.data);
        return args.data;
      }),
      findMany: jest.fn().mockResolvedValue([{ amountMinor: 50_000, kind: "PAYMENT" }]),
    },
    invoiceLine: { findMany: jest.fn().mockResolvedValue([]) },
  };
  // Everything AFTER the insert (guardian lookup, receipt notification) is not
  // what these cases are about, and stubbing each model by hand would make the
  // test fail whenever an unrelated read is added. Unknown models answer empty.
  const tolerant = new Proxy(tx as Record<string, unknown>, {
    get: (target, prop: string) =>
      prop in target
        ? target[prop]
        : {
            findMany: jest.fn().mockResolvedValue([]),
            findFirst: jest.fn().mockResolvedValue(null),
            create: jest.fn().mockResolvedValue({}),
            update: jest.fn().mockResolvedValue({}),
          },
  });
  const db = { runAsTenant: jest.fn(async (_c: unknown, fn: (t: unknown) => unknown) => fn(tolerant)) };
  const svc = Object.create(InvoiceSettlementService.prototype) as InvoiceSettlementService;
  Object.assign(svc, {
    db,
    audit: { record: jest.fn() },
    notifications: { enqueue: jest.fn() },
    // Settlement asks whether the school is switched off before it posts
    // anything — a DISABLED school receives nothing. These cases are about a
    // live school's settlement bank, so the stub says ACTIVE explicitly.
    schoolStatus: { isActive: async () => true },
    logger: { log: jest.fn(), warn: jest.fn(), error: jest.fn() },
  });
  return { svc, created, tx };
}

const charge = {
  schoolId: SCHOOL,
  invoiceId: INVOICE,
  creditMinor: 50_000,
  chargedMinor: 50_000,
  reference: "PS-abc-123",
  currency: "NGN",
  note: "Online (Paystack)",
};

describe("held funds", () => {
  afterEach(() => jest.restoreAllMocks());

  it("marks a charge as PLATFORM-HELD when the school has no settlement bank", async () => {
    const { svc, created } = makeService({ subaccount: null });
    await svc.applyOnlinePayment(charge as never);
    expect(created).toHaveLength(1);
    expect(created[0].settledToPlatform).toBe(true);
    // and the invoice is still credited in full — the parent DID pay, and
    // pretending otherwise would punish them for the school's missing config
    expect(created[0].amountMinor).toBe(50_000);
  });

  it("does NOT mark it held when the school's own bank is registered", async () => {
    const { svc, created } = makeService({ subaccount: "ACCT_live" });
    await svc.applyOnlinePayment(charge as never);
    expect(created[0].settledToPlatform).toBe(false);
  });

  it("decides from the school's state at SETTLEMENT time, not from the caller", async () => {
    // The flag must not be something a rail can pass in and get wrong. Every
    // rail — card, mobile money, virtual account, reconciliation sweep — goes
    // through this one path precisely so they cannot disagree about it.
    const { svc, created, tx } = makeService({ subaccount: null });
    await svc.applyOnlinePayment({ ...charge, settledToPlatform: false } as never);
    expect(tx.school.findFirst).toHaveBeenCalled();
    expect(created[0].settledToPlatform).toBe(true);
  });

  it("still refuses a currency mismatch before deciding anything about settlement", async () => {
    // The existing guard has to keep winning: a mismatched charge must not post
    // at all, held or otherwise.
    const { svc, created } = makeService({ subaccount: null });
    const out = await svc.applyOnlinePayment({ ...charge, currency: "GHS" } as never);
    expect(out).toBe("currency_mismatch");
    expect(created).toHaveLength(0);
  });

  it("stays idempotent — a retried webhook does not record the debt twice", async () => {
    const { svc, created, tx } = makeService({ subaccount: null });
    tx.payment.findFirst.mockResolvedValue({ id: "existing" });
    const out = await svc.applyOnlinePayment(charge as never);
    expect(out).toBe("duplicate");
    expect(created).toHaveLength(0);
  });
});
