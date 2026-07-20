// =============================================================================
// OperatorCreditsService — cross-tenant message-credit oversight (unit)
// =============================================================================
// Proves: balance-list aggregation sums per school without leaking across
// schools, the reason-split totals (purchased/sent/adjusted) are correct, the
// comp/adjust write lands under the TARGET school's GUC while the audit row
// lands under the OPERATOR's own tenant (the exact regression class covered
// for setSubscription in operator-subscription.service.spec.ts), a zero/blank
// adjustment is rejected, and every privileged read 503s when unconfigured.

import { BadRequestException, NotFoundException, ServiceUnavailableException } from "@nestjs/common";
import { OperatorCreditsService } from "../../src/operator/operator-credits.service";
import type { Principal, TenantContext, TenantTx } from "../../src/integrity/integrity.foundation";

const OPERATOR_SCHOOL = "school-A";
const TARGET_SCHOOL = "school-B";
const owner: Principal = { schoolId: OPERATOR_SCHOOL, userId: "op-1", roles: ["super_admin"], permissions: ["platform.operate"] };

function makePrivilegedClient() {
  return {
    school: {
      count: jest.fn().mockResolvedValue(2),
      findMany: jest.fn().mockResolvedValue([
        { id: "s1", name: "Alpha" },
        { id: "s2", name: "Beta" },
      ]),
      findFirst: jest.fn().mockResolvedValue({ id: "s1" }),
    },
    messageCreditEntry: {
      groupBy: jest.fn().mockResolvedValue([
        { schoolId: "s1", reason: "PURCHASE", _sum: { deltaCredits: 1000 } },
        { schoolId: "s1", reason: "SEND", _sum: { deltaCredits: -340 } },
        { schoolId: "s1", reason: "ADJUST", _sum: { deltaCredits: 50 } },
        { schoolId: "s2", reason: "PURCHASE", _sum: { deltaCredits: 200 } },
        // s2 has never sent or been adjusted — no rows for those reasons.
      ]),
      findMany: jest.fn().mockResolvedValue([
        { id: "e2", deltaCredits: 50, reason: "ADJUST", channel: null, reference: "goodwill comp", createdAt: new Date() },
        { id: "e1", deltaCredits: 1000, reason: "PURCHASE", channel: null, reference: "PSK-ref", createdAt: new Date() },
      ]),
    },
  };
}

function makeService(client: ReturnType<typeof makePrivilegedClient> | null) {
  const txSchools: string[] = [];
  const tx = {
    school: { findFirst: jest.fn().mockResolvedValue({ id: TARGET_SCHOOL }) },
    messageCreditEntry: {
      create: jest.fn().mockResolvedValue({}),
      aggregate: jest.fn().mockResolvedValue({ _sum: { deltaCredits: 150 } }),
    },
  } as unknown as TenantTx;
  const db = {
    runAsTenant: jest.fn(<T>(ctx: TenantContext, fn: (t: TenantTx) => Promise<T>) => {
      txSchools.push(ctx.schoolId);
      return fn(tx);
    }),
  };
  const audit = { record: jest.fn().mockResolvedValue(undefined) };
  const service = new OperatorCreditsService(db as never, audit as never, { client } as never);
  return { service, tx, audit, txSchools };
}

describe("OperatorCreditsService", () => {
  describe("listBalances", () => {
    it("sums PURCHASE/SEND/ADJUST per school into a balance + lifetime totals, without cross-school leakage", async () => {
      const { service } = makeService(makePrivilegedClient());
      const out = await service.listBalances(owner, {});
      expect(out.total).toBe(2);
      expect(out.rows).toEqual([
        { schoolId: "s1", schoolName: "Alpha", balance: 1000 - 340 + 50, totalPurchased: 1000, totalSent: 340, totalAdjusted: 50 },
        { schoolId: "s2", schoolName: "Beta", balance: 200, totalPurchased: 200, totalSent: 0, totalAdjusted: 0 },
      ]);
    });

    it("excludes the platform org and applies the name search", async () => {
      const client = makePrivilegedClient();
      const { service } = makeService(client);
      await service.listBalances(owner, { q: "alph" });
      expect(client.school.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { isPlatform: false, name: { contains: "alph", mode: "insensitive" } },
        }),
      );
    });

    it("503s when the privileged client is not configured", async () => {
      const { service } = makeService(null);
      await expect(service.listBalances(owner, {})).rejects.toBeInstanceOf(ServiceUnavailableException);
    });
  });

  describe("listLedger", () => {
    it("returns the school's ledger newest-first", async () => {
      const { service } = makeService(makePrivilegedClient());
      const out = await service.listLedger(owner, "s1");
      expect(out).toHaveLength(2);
      expect(out[0].reason).toBe("ADJUST");
    });

    it("404s (not 403) for an unknown school", async () => {
      const client = makePrivilegedClient();
      client.school.findFirst.mockResolvedValue(null);
      const { service } = makeService(client);
      await expect(service.listLedger(owner, "ghost")).rejects.toBeInstanceOf(NotFoundException);
    });

    it("503s when the privileged client is not configured", async () => {
      const { service } = makeService(null);
      await expect(service.listLedger(owner, "s1")).rejects.toBeInstanceOf(ServiceUnavailableException);
    });
  });

  describe("adjust", () => {
    it("writes the ledger row under the TARGET tenant and the audit under the OPERATOR's own tenant", async () => {
      const { service, tx, audit, txSchools } = makeService(makePrivilegedClient());
      const res = await service.adjust(owner, TARGET_SCHOOL, 100, "goodwill comp — gateway outage");

      expect(txSchools).toEqual([TARGET_SCHOOL, OPERATOR_SCHOOL]);
      expect(tx.messageCreditEntry.create).toHaveBeenCalledWith({
        data: { schoolId: TARGET_SCHOOL, deltaCredits: 100, reason: "ADJUST", reference: "goodwill comp — gateway outage" },
      });
      expect(res).toEqual({ ok: true, newBalance: 150 });

      expect(audit.record).toHaveBeenCalledTimes(1);
      const entry = (audit.record as jest.Mock).mock.calls[0][0];
      expect(entry.schoolId).toBe(OPERATOR_SCHOOL);
      expect(entry.action).toBe("operator.credits.adjust");
      expect(entry.metadata).toMatchObject({ targetSchoolId: TARGET_SCHOOL, delta: 100, newBalance: 150 });
    });

    it("rejects a zero delta", async () => {
      const { service } = makeService(makePrivilegedClient());
      await expect(service.adjust(owner, TARGET_SCHOOL, 0, "oops")).rejects.toBeInstanceOf(BadRequestException);
    });

    it("rejects a blank note", async () => {
      const { service } = makeService(makePrivilegedClient());
      await expect(service.adjust(owner, TARGET_SCHOOL, 50, "   ")).rejects.toBeInstanceOf(BadRequestException);
    });

    it("404s (not 403) for an unknown school", async () => {
      const { service, tx } = makeService(makePrivilegedClient());
      (tx.school.findFirst as jest.Mock).mockResolvedValue(null);
      await expect(service.adjust(owner, "ghost", 50, "note")).rejects.toBeInstanceOf(NotFoundException);
    });

    it("a negative delta debits (correcting an over-comp / gateway error)", async () => {
      const { service, tx } = makeService(makePrivilegedClient());
      await service.adjust(owner, TARGET_SCHOOL, -50, "correcting duplicate comp");
      expect(tx.messageCreditEntry.create).toHaveBeenCalledWith({
        data: { schoolId: TARGET_SCHOOL, deltaCredits: -50, reason: "ADJUST", reference: "correcting duplicate comp" },
      });
    });
  });
});
