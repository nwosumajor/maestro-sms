// =============================================================================
// Paying a school the fee money the platform is holding for it
// =============================================================================
// A parent's card payment made BEFORE the school registered a settlement bank
// lands in the PLATFORM's gateway account. The invoice is correctly PAID and the
// cash is the platform's to hand over. The school's fees page showed that
// balance under the only instruction the product could offer — "contact support
// to have this released" — so the number could only ever go UP, nothing recorded
// that a transfer had happened, and the two sides reconciled it in email.
//
// This does not move money; a person does that at a bank. What it does is make
// the transfer a RECORD, and the property that matters is that the balance falls
// because SPECIFIC PAYMENTS were discharged rather than because a total was
// edited. Every test below is about that distinction.
// =============================================================================

import { BadRequestException, NotFoundException } from "@nestjs/common";
import { SettlementReleaseService } from "../../src/operator/settlement-release.service";
import type { Principal, TenantContext, TenantTx } from "../../src/integrity/integrity.foundation";

const operator: Principal = {
  schoolId: "PLATFORM",
  userId: "op-1",
  roles: ["super_admin"],
  permissions: ["platform.subscription.manage"],
};
const SCHOOL = "school-a";

type Held = { id: string; amountMinor: number; currency: string };

function makeService(opts: { held?: Held[]; releases?: unknown[]; noPrivileged?: boolean; noSchool?: boolean } = {}) {
  const held = [...(opts.held ?? [])];
  const created: Array<Record<string, unknown>> = [];
  const stamped: Array<{ ids: string[]; releaseId: string }> = [];
  const audits: Array<{ action: string; metadata?: Record<string, unknown> }> = [];

  const tx = {
    payment: {
      findMany: jest.fn(async () =>
        held.map((h) => ({ id: h.id, amountMinor: h.amountMinor, invoice: { currency: h.currency } })),
      ),
      updateMany: jest.fn(async (a: { where: { id: { in: string[] } }; data: { platformReleaseId: string } }) => {
        stamped.push({ ids: a.where.id.in, releaseId: a.data.platformReleaseId });
        // Discharged rows leave the held set, exactly as the `platformReleaseId:
        // null` filter would make them.
        for (const id of a.where.id.in) {
          const i = held.findIndex((h) => h.id === id);
          if (i >= 0) held.splice(i, 1);
        }
        return { count: a.where.id.in.length };
      }),
    },
    platformSettlementRelease: {
      create: jest.fn(async (a: { data: Record<string, unknown> }) => {
        created.push(a.data);
        return { id: `rel-${created.length}` };
      }),
      findMany: jest.fn(async () => opts.releases ?? []),
    },
  } as unknown as TenantTx;

  const db = { runAsTenant: <T>(_c: TenantContext, fn: (t: TenantTx) => Promise<T>) => fn(tx) };
  const audit = {
    record: jest.fn(async (e: { action: string; metadata?: Record<string, unknown> }) => {
      audits.push(e);
    }),
  };
  const privileged = {
    client: opts.noPrivileged
      ? null
      : { school: { findFirst: jest.fn(async () => (opts.noSchool ? null : { id: SCHOOL })) } },
  };
  return {
    service: new SettlementReleaseService(db as never, audit as never, privileged as never),
    created,
    stamped,
    audits,
    tx,
  };
}

const NGN = (id: string, amountMinor: number): Held => ({ id, amountMinor, currency: "NGN" });

describe("what the platform still owes", () => {
  it("is a SUM over undischarged payments, not a stored total", async () => {
    const { service } = makeService({ held: [NGN("p1", 30000), NGN("p2", 20000)] });
    const out = await service.holding(operator, SCHOOL);
    expect(out.held).toEqual([{ currency: "NGN", amountMinor: 50000, paymentCount: 2 }]);
  });

  it("is zero when nothing is held", async () => {
    const { service } = makeService({ held: [] });
    const out = await service.holding(operator, SCHOOL);
    expect(out.held).toEqual([]);
  });

  it("takes each payment's currency from its INVOICE, not the school's today", async () => {
    // Invoice money carries its own currency per row, so an old NGN invoice
    // stays NGN whatever the school later charges in. Reading the school's
    // current currency would misdescribe every older payment.
    const { service, tx } = makeService({ held: [NGN("p1", 100)] });
    await service.holding(operator, SCHOOL);
    expect((tx.payment.findMany as jest.Mock).mock.calls[0][0].select).toMatchObject({
      invoice: { select: { currency: true } },
    });
  });
});

describe("recording that it has been paid", () => {
  it("discharges the payments and drops the balance to zero", async () => {
    const { service, stamped } = makeService({ held: [NGN("p1", 30000), NGN("p2", 20000)] });
    const out = await service.release(operator, SCHOOL, { reference: "FT2026081600123" });
    expect(stamped[0].ids.sort()).toEqual(["p1", "p2"]);
    expect(out.held).toEqual([]);
  });

  it("records the amount and count it actually covered", async () => {
    const { service, created } = makeService({ held: [NGN("p1", 30000), NGN("p2", 20000)] });
    await service.release(operator, SCHOOL, { reference: "FT-1", note: "monthly sweep" });
    expect(created[0]).toMatchObject({
      schoolId: SCHOOL,
      amountMinor: 50000,
      currency: "NGN",
      paymentCount: 2,
      reference: "FT-1",
      note: "monthly sweep",
      releasedById: "op-1",
    });
  });

  it("stamps the payments with the release that discharged them", async () => {
    const { service, stamped, created } = makeService({ held: [NGN("p1", 100)] });
    await service.release(operator, SCHOOL, { reference: "FT-1" });
    expect(created).toHaveLength(1);
    expect(stamped[0].releaseId).toBe("rel-1");
  });

  it("audits it against the school whose money it was", async () => {
    const { service, audits } = makeService({ held: [NGN("p1", 100)] });
    await service.release(operator, SCHOOL, { reference: "FT-1" });
    const entry = audits.find((a) => a.action === "platform.settlement.release");
    expect(entry?.metadata).toMatchObject({ amountMinor: 100, currency: "NGN", reference: "FT-1", paymentCount: 1 });
  });

  it("REFUSES a second press, so one transfer cannot be recorded twice", async () => {
    // The protection is not a flag but the data: the first release discharges
    // every held payment, and the second finds none.
    const { service, created } = makeService({ held: [NGN("p1", 100)] });
    await service.release(operator, SCHOOL, { reference: "FT-1" });
    await expect(service.release(operator, SCHOOL, { reference: "FT-1" })).rejects.toBeInstanceOf(BadRequestException);
    expect(created).toHaveLength(1);
  });

  it("refuses when there is nothing held at all", async () => {
    const { service } = makeService({ held: [] });
    await expect(service.release(operator, SCHOOL, { reference: "FT-1" })).rejects.toThrow(/nothing held/i);
  });

  it("requires the bank's own reference", async () => {
    // A release with no evidence outside this system is an assertion, not a
    // record — nothing could ever be reconciled against a bank statement.
    const { service, created } = makeService({ held: [NGN("p1", 100)] });
    await expect(service.release(operator, SCHOOL, { reference: "  " })).rejects.toThrow(/reference/i);
    expect(created).toEqual([]);
  });

  it("refuses a school that does not exist", async () => {
    const { service } = makeService({ held: [NGN("p1", 100)], noSchool: true });
    await expect(service.release(operator, SCHOOL, { reference: "FT-1" })).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe("a school holding more than one currency", () => {
  const mixed = [NGN("p1", 30000), { id: "p2", amountMinor: 20000, currency: "GHS" }];

  it("reports each currency separately rather than adding them up", async () => {
    // 30000 kobo and 20000 pesewas are not 50000 of anything.
    //
    // This case existed and asserted only that the LABEL went null — it never
    // checked the NUMBER, and the number was 50000. The reasoning was written
    // down in the comment above and the assertion missed it, so the screen went
    // on printing kobo-plus-pesewas under the platform's own symbol.
    const { service } = makeService({ held: mixed });
    const out = await service.holding(operator, SCHOOL);
    expect(out.held).toEqual([
      { currency: "GHS", amountMinor: 20000, paymentCount: 1 },
      { currency: "NGN", amountMinor: 30000, paymentCount: 1 },
    ]);
    // The sum that used to be reported is not reported by anything.
    expect(out.held.some((h) => h.amountMinor === 50000)).toBe(false);
  });

  it("refuses a release that does not say which currency", async () => {
    const { service, created } = makeService({ held: mixed });
    await expect(service.release(operator, SCHOOL, { reference: "FT-1" })).rejects.toThrow(/one currency at a time/i);
    expect(created).toEqual([]);
  });

  it("releases only the named currency, leaving the rest owed", async () => {
    const { service, created, stamped } = makeService({ held: mixed });
    const out = await service.release(operator, SCHOOL, { reference: "FT-1", currency: "ngn" });
    expect(created[0]).toMatchObject({ amountMinor: 30000, currency: "NGN", paymentCount: 1 });
    expect(stamped[0].ids).toEqual(["p1"]);
    expect(out.held).toEqual([{ currency: "GHS", amountMinor: 20000, paymentCount: 1 }]); // still owed
  });

  it("refuses a currency nothing is held in", async () => {
    const { service } = makeService({ held: mixed });
    await expect(service.release(operator, SCHOOL, { reference: "FT-1", currency: "KES" })).rejects.toThrow(/KES/);
  });
});
