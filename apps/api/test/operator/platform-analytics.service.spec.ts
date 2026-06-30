// =============================================================================
// PlatformAnalyticsService — cross-tenant business metrics (unit)
// =============================================================================
// Proves the platform owner's dashboard: excludes the platform org, sums PAID
// revenue, derives effective plan mix + people counts across customer schools,
// and 503s when the privileged client is unconfigured.

import { ServiceUnavailableException } from "@nestjs/common";
import { PlatformAnalyticsService } from "../../src/operator/platform-analytics.service";
import type { Principal } from "../../src/integrity/integrity.foundation";

const owner: Principal = { schoolId: "platform", userId: "owner", roles: ["super_admin"], permissions: ["platform.operate"] };

function makeClient() {
  return {
    school: {
      findMany: jest.fn().mockResolvedValue([
        { id: "s1", name: "Alpha", status: "ACTIVE" },
        { id: "s2", name: "Beta", status: "DISABLED" },
      ]),
    },
    schoolSubscription: {
      findMany: jest.fn().mockResolvedValue([
        { schoolId: "s1", plan: "STANDARD", status: "ACTIVE", currentPeriodEnd: null },
        // s2 has no subscription row -> defaults to ACTIVE/ENTERPRISE.
      ]),
    },
    userRole: {
      findMany: jest.fn().mockResolvedValue([
        { userId: "u1", role: { name: "student" } },
        { userId: "u2", role: { name: "student" } },
        { userId: "u3", role: { name: "teacher" } },
        { userId: "u3", role: { name: "principal" } }, // same staff user, 2 roles -> counted once
      ]),
    },
    platformSubscriptionPayment: {
      findMany: jest.fn().mockResolvedValue([
        { schoolId: "s1", plan: "STANDARD", amountMinor: 500000, status: "PAID", createdAt: new Date() },
        { schoolId: "s1", plan: "STANDARD", amountMinor: 300000, status: "PAID", createdAt: new Date("2020-01-01") },
      ]),
    },
    onboardingRequest: {
      groupBy: jest.fn().mockResolvedValue([
        { status: "NEW", _count: { _all: 2 } },
        { status: "APPROVED", _count: { _all: 1 } },
      ]),
    },
  };
}

function makeService(client: ReturnType<typeof makeClient> | null) {
  const audit = { record: jest.fn().mockResolvedValue(undefined) };
  const db = { runAsTenant: <T>(_c: unknown, fn: (t: unknown) => Promise<T>) => fn({}) };
  const privileged = { client };
  return { service: new PlatformAnalyticsService(db as never, audit as never, privileged as never), audit };
}

describe("PlatformAnalyticsService", () => {
  it("aggregates schools, plan mix, people and revenue across customer tenants", async () => {
    const client = makeClient();
    const { service } = makeService(client);
    const out = await service.overview(owner);

    expect(out.schools).toEqual({ total: 2, active: 1, disabled: 1 });
    // s1 STANDARD (active) + s2 no-sub -> ENTERPRISE default.
    expect(out.schoolsByPlan).toEqual({ STANDARD: 1, ENTERPRISE: 1 });
    expect(out.schoolsByStatus.ACTIVE).toBe(2); // both effectively active
    expect(out.people).toEqual({ students: 2, staff: 1 }); // u3 counted once
    expect(out.revenue.paidTotalMinor).toBe(800000);
    expect(out.revenue.payments).toBe(2);
    expect(out.revenue.last30dMinor).toBe(500000); // only the recent one
    expect(out.onboardingPipeline).toEqual({ NEW: 2, APPROVED: 1 });
    expect(out.recentPayments[0].schoolName).toBe("Alpha");
  });

  it("excludes the platform org from the school query", async () => {
    const client = makeClient();
    const { service } = makeService(client);
    await service.overview(owner);
    expect(client.school.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { isPlatform: false } }),
    );
  });

  it("503s when the privileged client is not configured", async () => {
    const { service } = makeService(null);
    await expect(service.overview(owner)).rejects.toBeInstanceOf(ServiceUnavailableException);
  });

  it("audits the view under the operator's own tenant", async () => {
    const { service, audit } = makeService(makeClient());
    await service.auditView(owner);
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: "operator.analytics.view", schoolId: "platform" }),
      expect.anything(),
    );
  });
});
