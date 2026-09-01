// =============================================================================
// An award granted in error was permanent
// =============================================================================
// There was no transition out of AWARDED anywhere in the module — no revoke, no
// reverse, no rescind. `decide` refuses anything already awarded as "finalised",
// the credit sits on the pupil's invoice as a POSTED payment, and the position
// stays consumed. An award to the wrong candidate cost one of only THREE places
// for the whole programme, permanently.
//
// The partial unique index that now holds Best Three makes it sharper: the
// position cannot even be reassigned while a mistaken award holds it. Adding the
// constraint without adding a way out would have been the worse half of a fix.
//
// THE MONEY IS REVERSED BY DOUBLE ENTRY, never by deleting anything: a REFUND
// payment for exactly what was credited — the same shape this platform already
// uses to move an overpayment off an invoice. A financial record is not
// rewritten, and the pair reads as what happened.
//
// The application returns to QUALIFIED, not to a REVOKED dead end. The mistake
// was the award, not the qualification: the candidate is still eligible and the
// position is free for whoever should have had it.
// =============================================================================

import { BadRequestException, NotFoundException } from "@nestjs/common";
import { ScholarshipAdminService } from "../../src/scholarship/scholarship-admin.service";

const P = { schoolId: "PLAT", userId: "owner-1", roles: ["super_admin"], permissions: ["scholarship.admin"] } as never;

function make(over: { status?: string; paymentId?: string | null; otherPayments?: Array<Record<string, unknown>> } = {}) {
  const created: Array<Record<string, unknown>> = [];
  const app = {
    id: "app-1", schoolId: "school-1", studentId: "pupil-1", programId: "prog-1",
    status: over.status ?? "AWARDED",
    disbursementPaymentId: over.paymentId === undefined ? "pay-award" : over.paymentId,
  };
  const credit = { id: "pay-award", invoiceId: "inv-1", amountMinor: 500_000 };
  const db = {
    scholarshipApplication: {
      findFirst: jest.fn().mockResolvedValue(app),
      findMany: jest.fn().mockResolvedValue([app]),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    payment: {
      findFirst: jest.fn().mockResolvedValue(credit),
      findMany: jest.fn().mockResolvedValue([
        { amountMinor: 500_000, kind: "SCHOLARSHIP" },
        ...(over.otherPayments ?? []),
        { amountMinor: 500_000, kind: "REFUND" },
      ]),
      create: jest.fn(({ data }: { data: Record<string, unknown> }) => {
        created.push(data);
        return Promise.resolve({ id: "pay-refund", ...data });
      }),
    },
    invoice: { findFirst: jest.fn().mockResolvedValue({ totalMinor: 1_000_000 }), update: jest.fn().mockResolvedValue({}) },
  };
  const s = Object.create(ScholarshipAdminService.prototype) as ScholarshipAdminService;
  Object.assign(s, {
    // The entitlement cache, dropped when a school prize is granted.
    modules: { invalidate: jest.fn() },
    // Every real instance has one — Nest constructs it as a field.
    logger: { error: jest.fn(), warn: jest.fn(), log: jest.fn() }, privileged: { client: db }, notifications: {}, audit: { record: jest.fn() } });
  (s as unknown as { client: unknown }).client = () => db;
  (s as unknown as { auditOwn: unknown }).auditOwn = jest.fn().mockResolvedValue(undefined);
  const notifyFamily = jest.fn().mockResolvedValue(undefined);
  (s as unknown as { notifyFamily: unknown }).notifyFamily = notifyFamily;
  (s as unknown as { listApplicationById: unknown }).listApplicationById = jest.fn().mockResolvedValue([{ id: "app-1" }]);
  return { s, db, created, notifyFamily };
}

describe("taking an award back", () => {
  it("reverses the credit with a REFUND for exactly what was given", async () => {
    const { s, created } = make();
    await s.revokeAward(P, "app-1", "awarded to the wrong candidate");
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({ kind: "REFUND", status: "POSTED", amountMinor: 500_000, invoiceId: "inv-1" });
  });

  it("never deletes the original payment — the pair is the record", async () => {
    const { s, db } = make();
    await s.revokeAward(P, "app-1", "wrong candidate");
    expect((db.payment as unknown as { delete?: unknown }).delete).toBeUndefined();
    expect(db.payment.create).toHaveBeenCalledTimes(1);
  });

  it("points the reversal back at the award it undoes", async () => {
    // So the ledger is legible without knowing this feature exists.
    const { s, created } = make();
    await s.revokeAward(P, "app-1", "wrong candidate");
    expect(created[0].reference).toBe("SCHOLARSHIP-REVERSAL:app-1");
    expect(String(created[0].note)).toContain("wrong candidate");
  });

  it("frees the position and returns the candidate to QUALIFIED", async () => {
    const { s, db } = make();
    await s.revokeAward(P, "app-1", "wrong candidate");
    const data = (db.scholarshipApplication.updateMany as jest.Mock).mock.calls[0][0].data;
    expect(data).toMatchObject({ status: "QUALIFIED", awardPosition: null, awardMinor: null, disbursementPaymentId: null });
  });

  it("recomputes the invoice from the ledger rather than assuming", async () => {
    // Other payments may have landed since the award; the status has to reflect
    // what is actually owed now.
    const { s, db } = make();
    await s.revokeAward(P, "app-1", "wrong candidate");
    expect(db.payment.findMany).toHaveBeenCalled();
    expect((db.invoice.update as jest.Mock).mock.calls[0][0].data.status).toBe("ISSUED");
  });

  it("tells the family, who were told they had won", async () => {
    const { s, notifyFamily } = make();
    await s.revokeAward(P, "app-1", "a marking error");
    expect(notifyFamily).toHaveBeenCalled();
    expect(String(notifyFamily.mock.calls[0][4])).toContain("a marking error");
  });

  it("claims it, so two revocations cannot each post a refund", async () => {
    const { s, db, created } = make();
    (db.scholarshipApplication.updateMany as jest.Mock).mockResolvedValue({ count: 0 });
    await expect(s.revokeAward(P, "app-1", "x")).rejects.toThrow(BadRequestException);
    expect(created).toHaveLength(0);
  });
});

describe("what it refuses", () => {
  it.each([["QUALIFIED"], ["SHORTLISTED"], ["REJECTED"], ["SUBMITTED"]])(
    "an application that is %s — there is no award to take back",
    async (status) => {
      const { s, created } = make({ status });
      await expect(s.revokeAward(P, "app-1", "x")).rejects.toThrow(BadRequestException);
      expect(created).toHaveLength(0);
    },
  );

  it("an application that does not exist", async () => {
    const { s, db } = make();
    (db.scholarshipApplication.findFirst as jest.Mock).mockResolvedValue(null);
    await expect(s.revokeAward(P, "app-1", "x")).rejects.toThrow(NotFoundException);
  });

  it("still frees the position when the award never disbursed", async () => {
    // A non-FEES_CREDIT award, or one made when nothing was owed: there is no
    // payment to reverse, and the position must still come back.
    const { s, db, created } = make({ paymentId: null });
    await s.revokeAward(P, "app-1", "wrong candidate");
    expect(created).toHaveLength(0);
    expect((db.scholarshipApplication.updateMany as jest.Mock).mock.calls[0][0].data.awardPosition).toBeNull();
  });
});
