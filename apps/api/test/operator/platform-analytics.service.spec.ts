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
  const now = new Date();
  return {
    school: {
      findMany: jest.fn().mockResolvedValue([
        { id: "s1", name: "Alpha", status: "ACTIVE", createdAt: now },
        { id: "s2", name: "Beta", status: "DISABLED", createdAt: now },
      ]),
    },
    schoolSubscription: {
      findMany: jest.fn().mockResolvedValue([
        { schoolId: "s1", plan: "STANDARD", status: "ACTIVE", currentPeriodEnd: null, seats: 10, overrides: null },
        // s2 has no subscription row -> fail-closed to the STANDARD floor (DEFAULT_PLAN).
      ]),
    },
    userRole: {
      findMany: jest.fn().mockResolvedValue([
        { userId: "u1", schoolId: "s1", role: { name: "student" } },
        { userId: "u2", schoolId: "s1", role: { name: "student" } },
        { userId: "u3", schoolId: "s1", role: { name: "teacher" } },
        { userId: "u3", schoolId: "s1", role: { name: "principal" } }, // same staff user, 2 roles -> counted once
      ]),
    },
    user: {
      findMany: jest.fn().mockResolvedValue([{ createdAt: now }, { createdAt: now }]),
    },
    studentProfile: {
      findMany: jest.fn().mockResolvedValue([
        { gender: "male", dateOfBirth: new Date("2015-01-01") },
        { gender: "Female", dateOfBirth: new Date("2012-01-01") },
      ]),
    },
    platformSubscriptionPayment: {
      findMany: jest.fn().mockResolvedValue([
        { schoolId: "s1", plan: "STANDARD", amountMinor: 500000, status: "PAID", createdAt: now },
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
    // s1 STANDARD (active) + s2 no-sub -> fail-closed STANDARD floor (DEFAULT_PLAN).
    expect(out.schoolsByPlan).toEqual({ STANDARD: 2 });
    expect(out.schoolsByStatus.ACTIVE).toBe(2); // both effectively active
    expect(out.people).toEqual({ students: 2, staff: 1 }); // u3 counted once
    expect(out.revenue.paidTotalMinor).toBe(800000);
    expect(out.revenue.payments).toBe(2);
    expect(out.revenue.last30dMinor).toBe(500000); // only the recent one
    expect(out.onboardingPipeline).toEqual({ NEW: 2, APPROVED: 1 });
    expect(out.recentPayments[0].schoolName).toBe("Alpha");

    // --- extended decision-grade metrics ---
    // s1 STANDARD active, 10 seats × ₦200/seat/mo (20000 kobo) = 200000 MRR; s2 no-sub = not paying.
    expect(out.mrr.totalMinor).toBe(200000);
    expect(out.mrr.byPlan.STANDARD).toBe(200000);
    expect(out.mrr.payingSchools).toBe(1);
    expect(out.mrr.arpaMinor).toBe(200000);
    // funnel: 3 requests total, 1 approved, 2 provisioned schools, 1 paying.
    expect(out.funnel).toEqual({ requests: 3, approved: 1, provisioned: 2, paying: 1 });
    expect(out.risk).toEqual({ pastDue: 0, canceled: 0, atRiskMrrMinor: 0 });
    expect(out.growth).toHaveLength(6); // last 6 months
    expect(out.topSchools[0].name).toBe("Alpha"); // 2 students > 0
    expect(out.moduleAdoption.length).toBeGreaterThan(0);
    // demographics: normalised gender across all profiles.
    expect(out.demographics.profiled).toBe(2);
    expect(out.demographics.gender).toEqual({ Male: 1, Female: 1 });
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
