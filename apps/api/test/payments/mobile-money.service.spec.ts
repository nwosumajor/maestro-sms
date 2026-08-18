// =============================================================================
// Mobile money — the rail most African school fees actually travel on
// =============================================================================
// The properties worth pinning are not the happy path. They are:
//
//   1. AN UNSIGNED CALLBACK CANNOT MOVE MONEY IT DID NOT MOVE. M-Pesa and MTN do
//      not sign their callbacks. Everything about money comes from the intent we
//      wrote before the prompt went out — never from the payload.
//   2. SETTLEMENT USES THE ONE EXISTING PATH, so two rails cannot disagree about
//      whether an invoice is paid.
//   3. IDEMPOTENCE. Mobile money re-notifies aggressively.
//   4. NO SILENT FALLBACK. A payer who chose mobile money never gets a card page.
// =============================================================================

import { BadRequestException, NotFoundException } from "@nestjs/common";
import { MobileMoneyService } from "../../src/payments/mobile-money.service";
import type { Principal, TenantContext, TenantTx } from "../../src/integrity/integrity.foundation";

const SCHOOL = "s-1";
const payer: Principal = { schoolId: SCHOOL, userId: "u-1", roles: ["parent"], permissions: [] };

const INTENT = {
  id: "i-1",
  schoolId: SCHOOL,
  reference: "MM-ABC123",
  provider: "MPESA",
  invoiceId: "inv-1",
  amountMinor: 50_000, // KES 500.00 — what WE asked for
  currency: "KES",
  payerId: "u-1",
  status: "PENDING",
};

function makeService(over: Record<string, unknown> = {}) {
  const intentUpdate = jest.fn(async ({ data }: { data: Record<string, unknown> }) => ({ ...INTENT, ...data }));
  const tx = {
    invoice: {
      findFirst: jest.fn().mockResolvedValue(
        (over.invoice as unknown) ?? { id: "inv-1", totalMinor: 50_000, currency: "KES", status: "ISSUED", studentId: "st-1" },
      ),
    },
    payment: { aggregate: jest.fn().mockResolvedValue({ _sum: { amountMinor: 0 } }) },
    mobileMoneyIntent: {
      create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => ({ ...INTENT, ...data })),
      update: intentUpdate,
      findFirst: jest.fn().mockResolvedValue((over.intent as unknown) ?? null),
    },
  } as unknown as TenantTx;

  const db = {
    runAsTenant: <T>(_c: TenantContext, fn: (t: TenantTx) => Promise<T>) => fn(tx),
    runAsTenantReadOnly: <T>(_c: TenantContext, fn: (t: TenantTx) => Promise<T>) => fn(tx),
  };
  const region = { forSchool: jest.fn().mockResolvedValue({ country: (over.country as string) ?? "KE" }) };
  const settlement = { applyOnlinePayment: jest.fn().mockResolvedValue("posted") };
  const events = { record: jest.fn() };
  const privilegedFind = jest.fn().mockResolvedValue((over.intent as unknown) ?? null);
  const privileged = {
    client: over.noPrivileged ? null : { mobileMoneyIntent: { findFirst: privilegedFind } },
  };
  const charge = jest.fn().mockResolvedValue({ providerRef: "ws_CO_1", instruction: "Check your phone" });
  const mpesa = {
    key: "MPESA" as const,
    wholeUnitsOnly: over.wholeUnitsOnly !== false,
    isConfigured: () => over.mpesaConfigured !== false,
    charge,
    readCallback: (b: unknown) => (over.reading as never) ?? { reference: (b as { ref?: string })?.ref ?? null, outcome: "SUCCEEDED" },
    // The callback is no longer taken at its word (#262): a public, UNSIGNED
    // body cannot decide whether money moved, so the service asks the rail with
    // the same `getStatus` the recovery sweep uses. Every real adapter
    // implements it; this stub agrees with the callback so these cases still
    // assert what they were written to assert. `over.railSays` makes them
    // disagree.
    getStatus: jest.fn(async () =>
      (over.railSays as never) ??
      (over.reading as never) ?? { reference: null, outcome: "SUCCEEDED" as const }),
  };
  const mtn = { key: "MTN_MOMO" as const, wholeUnitsOnly: false, isConfigured: () => false, charge: jest.fn(), readCallback: () => ({ reference: null, outcome: "PENDING" as const }), getStatus: jest.fn(async () => ({ reference: null, outcome: "PENDING" as const })) };
  const airtel = { key: "AIRTEL" as const, wholeUnitsOnly: false, isConfigured: () => false, charge: jest.fn(), readCallback: () => ({ reference: null, outcome: "PENDING" as const }), getStatus: jest.fn(async () => ({ reference: null, outcome: "PENDING" as const })) };

  const svc = new MobileMoneyService(
    db as never, region as never, settlement as never, events as never, privileged as never,
    mpesa as never, mtn as never, airtel as never,
  );
  return { svc, tx, settlement, events, charge, intentUpdate, privilegedFind };
}

describe("options — what a school's payers can use", () => {
  it("lists the rails the COUNTRY has, flagging which are enabled", async () => {
    // Disabled rather than hidden: a school can see what it could ask for instead
    // of wondering why its neighbours have M-Pesa and it does not.
    const { svc } = makeService();
    const opts = await svc.options(SCHOOL);
    expect(opts.map((o) => o.provider)).toEqual(expect.arrayContaining(["MPESA", "AIRTEL"]));
    expect(opts.find((o) => o.provider === "MPESA")!.enabled).toBe(true);
    expect(opts.find((o) => o.provider === "AIRTEL")!.enabled).toBe(false);
  });

  it("returns nothing where no rail operates", async () => {
    const { svc } = makeService({ country: "GB" });
    await expect(svc.options(SCHOOL)).resolves.toEqual([]);
  });
});

describe("charge", () => {
  it("REFUSES a rail that does not operate in the school's country", async () => {
    // And never silently falls back to a card rail: a payer who chose mobile money
    // and got a card page has been misled about what will be debited.
    const { svc } = makeService({ country: "GB" });
    await expect(svc.charge(payer, { invoiceId: "inv-1", provider: "MPESA", phone: "0712345678" })).rejects.toThrow(
      /does not operate in GB/,
    );
  });

  it("refuses a rail the platform has no credentials for", async () => {
    const { svc } = makeService({ mpesaConfigured: false });
    await expect(svc.charge(payer, { invoiceId: "inv-1", provider: "MPESA", phone: "0712345678" })).rejects.toThrow(
      /not enabled/,
    );
  });

  it("refuses when the invoice currency is not what the rail settles", async () => {
    // M-Pesa Kenya settles KES. Charging a USD invoice on it needs an FX decision
    // nobody has made, so it is refused rather than guessed.
    const { svc } = makeService({ invoice: { id: "inv-1", totalMinor: 50_000, currency: "USD", status: "ISSUED", studentId: "st-1" } });
    await expect(svc.charge(payer, { invoiceId: "inv-1", provider: "MPESA", phone: "0712345678" })).rejects.toThrow(
      /settles in KES/,
    );
  });

  it("refuses an invoice with nothing outstanding", async () => {
    const { svc, tx } = makeService();
    (tx.payment.aggregate as jest.Mock).mockResolvedValue({ _sum: { amountMinor: 50_000 } });
    await expect(svc.charge(payer, { invoiceId: "inv-1", provider: "MPESA", phone: "0712345678" })).rejects.toThrow(
      /already settled/,
    );
  });

  it("404s an unknown invoice", async () => {
    const { svc, tx } = makeService();
    (tx.invoice.findFirst as jest.Mock).mockResolvedValue(null);
    await expect(svc.charge(payer, { invoiceId: "nope", provider: "MPESA", phone: "0712345678" })).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it("rejects a phone number it cannot normalise", async () => {
    const { svc } = makeService();
    await expect(svc.charge(payer, { invoiceId: "inv-1", provider: "MPESA", phone: "12" })).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it("records OUR amount before the prompt goes out, and charges the OUTSTANDING balance", async () => {
    // The intent is written first, deliberately: it is what the callback will be
    // settled against, so it must exist before anything leaves the building.
    const { svc, tx, charge } = makeService();
    (tx.payment.aggregate as jest.Mock).mockResolvedValue({ _sum: { amountMinor: 20_000 } });
    const out = await svc.charge(payer, { invoiceId: "inv-1", provider: "MPESA", phone: "0712345678" });

    expect((tx.mobileMoneyIntent.create as jest.Mock).mock.calls[0][0].data).toMatchObject({
      amountMinor: 30_000, // 50,000 total less 20,000 already paid
      currency: "KES",
      msisdn: "254712345678", // normalised from the local form
      provider: "MPESA",
    });
    expect(charge).toHaveBeenCalled();
    expect(out.status).toBe("PENDING"); // an acknowledgement, never a receipt
  });

  it("FLOORS the ask to whole units on a rail that cannot take fractions", async () => {
    // KES 500.50 outstanding on M-Pesa, which rejects decimals. Ask for 500, credit
    // 500, leave 0.50 on the invoice. Rounding UP would debit the payer 501 against
    // a 500.50 credit — 0.50 of their money with nothing in the ledger recording it.
    const { svc, tx } = makeService();
    (tx.invoice.findFirst as jest.Mock).mockResolvedValue({
      id: "inv-1", totalMinor: 50_050, currency: "KES", status: "ISSUED", studentId: "st-1",
    });
    await svc.charge(payer, { invoiceId: "inv-1", provider: "MPESA", phone: "0712345678" });
    expect((tx.mobileMoneyIntent.create as jest.Mock).mock.calls[0][0].data.amountMinor).toBe(50_000);
  });

  it("does NOT floor a rail that accepts fractions", async () => {
    // The constraint is M-Pesa's, not mobile money's. MTN MoMo takes decimals, and
    // flooring there would leave a permanently unpayable remainder on the invoice.
    const { svc, tx } = makeService({ wholeUnitsOnly: false });
    (tx.invoice.findFirst as jest.Mock).mockResolvedValue({
      id: "inv-1", totalMinor: 50_050, currency: "KES", status: "ISSUED", studentId: "st-1",
    });
    await svc.charge(payer, { invoiceId: "inv-1", provider: "MPESA", phone: "0712345678" });
    expect((tx.mobileMoneyIntent.create as jest.Mock).mock.calls[0][0].data.amountMinor).toBe(50_050);
  });

  it("refuses a balance below the smallest whole unit rather than asking for zero", async () => {
    const { svc, tx } = makeService();
    (tx.invoice.findFirst as jest.Mock).mockResolvedValue({
      id: "inv-1", totalMinor: 50, currency: "KES", status: "ISSUED", studentId: "st-1", // KES 0.50
    });
    await expect(
      svc.charge(payer, { invoiceId: "inv-1", provider: "MPESA", phone: "0712345678" }),
    ).rejects.toThrow(/less than the smallest amount/);
  });

  it("marks the intent FAILED when the rail refuses, rather than leaving it pending forever", async () => {
    const { svc, charge, intentUpdate } = makeService();
    charge.mockRejectedValue(new Error("STK push refused"));
    await expect(svc.charge(payer, { invoiceId: "inv-1", provider: "MPESA", phone: "0712345678" })).rejects.toThrow();
    expect(intentUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: "FAILED" }) }),
    );
  });
});

describe("callback — unsigned, so it is a doorbell and not a statement of fact", () => {
  it("settles OUR recorded amount, IGNORING any amount in the payload", async () => {
    // THE test. An unsigned callback claiming a million must credit the invoice
    // with what we asked for and nothing else.
    const { svc, settlement } = makeService({
      intent: INTENT,
      reading: { reference: "MM-ABC123", outcome: "SUCCEEDED", providerRef: "QK12" },
    });
    await svc.handleCallback("mpesa", { Amount: 100_000_000, ref: "MM-ABC123" });
    expect(settlement.applyOnlinePayment).toHaveBeenCalledWith(
      expect.objectContaining({ creditMinor: 50_000, chargedMinor: 50_000, invoiceId: "inv-1", schoolId: SCHOOL }),
    );
  });

  it("uses the ONE settlement path, keyed on our reference", async () => {
    // Not a second posting implementation: that is how two rails start disagreeing
    // about whether an invoice is paid.
    const { svc, settlement } = makeService({
      intent: INTENT,
      reading: { reference: "MM-ABC123", outcome: "SUCCEEDED" },
    });
    await svc.handleCallback("mpesa", {});
    expect(settlement.applyOnlinePayment).toHaveBeenCalledWith(
      expect.objectContaining({ reference: "MM-ABC123" }),
    );
  });

  it("REFUSES a forged success the rail does not confirm", async () => {
    // The attack this closes. `charge()` returns the reference TO THE PAYER, so
    // a parent could start a charge, decline the prompt, and POST a
    // success-shaped body to the public unsigned callback carrying their own
    // reference. The invoice settled for the full amount with no money moved,
    // and nothing corrected it: applyReading skips a non-PENDING intent, so the
    // recovery sweep never looked again.
    const { svc, settlement } = makeService({
      intent: INTENT,
      reading: { reference: "MM-ABC123", outcome: "SUCCEEDED" },
      railSays: { reference: "MM-ABC123", outcome: "PENDING" },
    });
    await svc.handleCallback("mpesa", {});
    expect(settlement.applyOnlinePayment).not.toHaveBeenCalled();
  });

  it("does not FAIL an intent on a forged failure either", async () => {
    // The mirror: a forged FAILED would bury a payment that did happen, because
    // the sweep skips anything no longer PENDING.
    const { svc, intentUpdate } = makeService({
      intent: INTENT,
      reading: { reference: "MM-ABC123", outcome: "FAILED", failureReason: "forged" },
      railSays: { reference: "MM-ABC123", outcome: "PENDING" },
    });
    await svc.handleCallback("mpesa", {});
    expect(intentUpdate).not.toHaveBeenCalled();
  });

  it("settles when the rail CONFIRMS the callback", async () => {
    // The honest path still works, which is what makes the guard safe to keep.
    const { svc, settlement } = makeService({
      intent: INTENT,
      reading: { reference: "MM-ABC123", outcome: "SUCCEEDED" },
      railSays: { reference: "MM-ABC123", outcome: "SUCCEEDED" },
    });
    await svc.handleCallback("mpesa", {});
    expect(settlement.applyOnlinePayment).toHaveBeenCalled();
  });

  it("is IDEMPOTENT — a re-notified charge posts nothing further", async () => {
    // Mobile money re-notifies aggressively.
    const { svc, settlement } = makeService({
      intent: { ...INTENT, status: "SUCCEEDED" },
      reading: { reference: "MM-ABC123", outcome: "SUCCEEDED" },
    });
    await svc.handleCallback("mpesa", {});
    expect(settlement.applyOnlinePayment).not.toHaveBeenCalled();
  });

  it("records a FAILURE without touching the ledger", async () => {
    const { svc, settlement, intentUpdate } = makeService({
      intent: INTENT,
      reading: { reference: "MM-ABC123", outcome: "FAILED", failureReason: "Request cancelled by user" },
    });
    await svc.handleCallback("mpesa", {});
    expect(settlement.applyOnlinePayment).not.toHaveBeenCalled();
    expect(intentUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: "FAILED" }) }),
    );
  });

  it("logs every callback to the shared gateway_event table", async () => {
    const { svc, events } = makeService({ intent: INTENT, reading: { reference: "MM-ABC123", outcome: "SUCCEEDED" } });
    await svc.handleCallback("mpesa", {});
    expect(events.record).toHaveBeenCalledWith(
      expect.objectContaining({ gateway: "MPESA", schoolId: SCHOOL, reference: "MM-ABC123" }),
    );
  });

  it("always answers 200, even for an unknown reference or rail", async () => {
    // A non-2xx makes a rail retry forever, and no retry fixes a payload we cannot
    // read. Silence is the correct handling of noise.
    const unknown = makeService({ intent: null, reading: { reference: "MM-NOPE", outcome: "SUCCEEDED" } });
    await expect(unknown.svc.handleCallback("mpesa", {})).resolves.toEqual({ ok: true });
    expect(unknown.settlement.applyOnlinePayment).not.toHaveBeenCalled();

    const badRail = makeService();
    await expect(badRail.svc.handleCallback("not_a_rail", {})).resolves.toEqual({ ok: true });
  });

  it("finds the charge by the RAIL'S OWN id when it does not echo ours", async () => {
    // M-Pesa never echoes our reference — its callback carries only
    // CheckoutRequestID. If the service can only look up by our reference, every
    // real payment is debited from the payer and never credited. This is the
    // service-side half of that fix; the adapter half is in mpesa-wire.spec.ts.
    const { svc, settlement, privilegedFind } = makeService({
      intent: { ...INTENT, providerRef: "ws_CO_191220191020363925" },
      reading: { reference: null, providerRef: "ws_CO_191220191020363925", outcome: "SUCCEEDED" },
    });
    await svc.handleCallback("mpesa", {});
    // The callback arrives unauthenticated, so the school is not known yet and the
    // lookup runs on the privileged client — the same shape the Paystack webhook uses.
    expect(privilegedFind.mock.calls[0][0].where).toEqual({
      providerRef: "ws_CO_191220191020363925",
      provider: "MPESA",
    });
    expect(settlement.applyOnlinePayment).toHaveBeenCalledWith(
      expect.objectContaining({ creditMinor: 50_000, reference: "MM-ABC123" }),
    );
  });

  it("ignores a still-PENDING notification", async () => {
    const { svc, settlement } = makeService({ intent: INTENT, reading: { reference: "MM-ABC123", outcome: "PENDING" } });
    await svc.handleCallback("mpesa", {});
    expect(settlement.applyOnlinePayment).not.toHaveBeenCalled();
  });
});
