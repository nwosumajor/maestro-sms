// =============================================================================
// Settlement onboarding — does the money reach the SCHOOL's own account?
// =============================================================================
// The defect these pin: creating a Paystack subaccount proves an account
// EXISTS, never that it belongs to the school. A transposed digit that still
// lands on a valid account at the same bank was accepted silently, and from
// that moment every parent's fee settled to a stranger — with the invoice
// correctly marked PAID at both ends, so nothing in this system would ever
// notice. The card even told the user "the account is verified with Paystack",
// which is the sentence that stops a careful person double-checking.
//
// So these cases are about the HUMAN check, not the HTTP call: the name has to
// be read back, and the save has to be impossible without it.
// =============================================================================

import { BadRequestException } from "@nestjs/common";
import { PaymentGatewayService } from "../../src/fees/payment-gateway.service";

const SCHOOL = "11111111-1111-1111-1111-111111111111";
const principal = { userId: "u-1", schoolId: SCHOOL, roles: ["school_admin"], permissions: [] } as never;

function makeService(opts: { resolvesTo?: string | null } = {}) {
  const createSubaccount = jest.fn().mockResolvedValue({ subaccountCode: "ACCT_x", bankName: "GTBank" });
  const resolveAccount = jest.fn().mockResolvedValue(
    opts.resolvesTo === null ? null : { accountName: opts.resolvesTo ?? "ST ANDREWS SCHOOL LTD" },
  );
  const paystack = { isConfigured: () => true, createSubaccount, resolveAccount, listBanks: jest.fn() };
  const school = { findFirst: jest.fn().mockResolvedValue({ id: SCHOOL, name: "St Andrews" }), update: jest.fn() };
  const privileged = { client: { school } };
  const db = { runAsTenant: jest.fn(async (_c: unknown, fn: (tx: unknown) => unknown) => fn({})) };
  const audit = { record: jest.fn() };
  const platformFees = { effective: jest.fn().mockResolvedValue({}) };

  const svc = Object.create(PaymentGatewayService.prototype) as PaymentGatewayService;
  Object.assign(svc, { paystack, privileged, db, audit, platformFees });
  // getSettlement re-reads through the tenant client; the assertions here are
  // about what happened BEFORE it, so a fixed shape is enough.
  jest.spyOn(svc, "getSettlement").mockResolvedValue({ configured: true } as never);
  return { svc, createSubaccount, resolveAccount, schoolUpdate: school.update };
}

describe("settlement onboarding", () => {
  afterEach(() => jest.restoreAllMocks());

  it("REFUSES to save an account the bank cannot resolve", async () => {
    const { svc, createSubaccount } = makeService({ resolvesTo: null });
    await expect(
      svc.setSettlement(principal, { bankCode: "058", accountNumber: "0123456789", confirmedAccountName: "ANY" }),
    ).rejects.toBeInstanceOf(BadRequestException);
    // and critically: no subaccount was created, so nothing was routed anywhere
    expect(createSubaccount).not.toHaveBeenCalled();
  });

  it("REFUSES when the confirmed name is not the name on the account", async () => {
    // The typo case, exactly: a valid account, but somebody else's.
    const { svc, createSubaccount } = makeService({ resolvesTo: "MUSA IBRAHIM" });
    await expect(
      svc.setSettlement(principal, {
        bankCode: "058",
        accountNumber: "0123456780",
        confirmedAccountName: "ST ANDREWS SCHOOL LTD",
      }),
    ).rejects.toThrow(/MUSA IBRAHIM/);
    expect(createSubaccount).not.toHaveBeenCalled();
  });

  it("resolves BEFORE creating the subaccount, never after", async () => {
    // Order is the property: a check that runs after the account is already
    // wired up is not a check, it is a report.
    const { svc, resolveAccount, createSubaccount } = makeService();
    await svc.setSettlement(principal, {
      bankCode: "058",
      accountNumber: "0123456789",
      confirmedAccountName: "ST ANDREWS SCHOOL LTD",
    });
    expect(resolveAccount.mock.invocationCallOrder[0]).toBeLessThan(createSubaccount.mock.invocationCallOrder[0]);
  });

  it("accepts a confirmation that differs only in case, spacing or punctuation", async () => {
    // Banks return names upper-cased with inconsistent punctuation. The school
    // is confirming that they RECOGNISE the name, not transcribing it — being
    // strict here would train people to paste it without reading.
    const { svc, createSubaccount } = makeService({ resolvesTo: "ST. ANDREWS  SCHOOL LTD" });
    await svc.setSettlement(principal, {
      bankCode: "058",
      accountNumber: "0123456789",
      confirmedAccountName: "st andrews school ltd",
    });
    expect(createSubaccount).toHaveBeenCalled();
  });

  it("stores only the last 4 digits of the account number", async () => {
    const { svc, schoolUpdate } = makeService();
    await svc.setSettlement(principal, {
      bankCode: "058",
      accountNumber: "0123456789",
      confirmedAccountName: "ST ANDREWS SCHOOL LTD",
    });
    const data = schoolUpdate.mock.calls[0][0].data as Record<string, unknown>;
    expect(data.settlementAccountLast4).toBe("6789");
    expect(JSON.stringify(data)).not.toContain("0123456789");
  });

  it("resolve is a pure lookup — it never creates a subaccount", async () => {
    // It has no step-up in front of it precisely because it commits to nothing.
    const { svc, createSubaccount, resolveAccount } = makeService();
    const out = await svc.resolveSettlementAccount(principal, { bankCode: "058", accountNumber: "0123456789" });
    expect(out.accountName).toBe("ST ANDREWS SCHOOL LTD");
    expect(resolveAccount).toHaveBeenCalled();
    expect(createSubaccount).not.toHaveBeenCalled();
  });

  it("rejects a malformed NUBAN before calling the gateway at all", async () => {
    const { svc, resolveAccount } = makeService();
    await expect(
      svc.resolveSettlementAccount(principal, { bankCode: "058", accountNumber: "12345" }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(resolveAccount).not.toHaveBeenCalled();
  });
});
