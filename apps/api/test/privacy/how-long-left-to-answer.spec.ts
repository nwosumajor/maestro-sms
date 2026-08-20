// =============================================================================
// An erasure request is time-bound, and the register did not say so
// =============================================================================
// Answering a data subject has a deadline. The row carried only the date it
// arrived, so the person responsible had to do the arithmetic on every line and
// know the period from memory — on the one register where being late is the
// failure itself.
//
// The breach register beside it has had a computed clock since it was built:
// notifyDueAt, overdue, deadlineIsStatutory. Nothing was missing conceptually;
// the same clock simply was never applied to subject requests. That is the tell
// this session keeps producing — a rule modelled carefully in one place and not
// in the one next to it.
//
// THE HONEST HALF. `deadlineIsStatutory` is false unless this platform has
// actually recorded a period for the school's regime. Only GDPR's Art. 12(3)
// month is recorded; every other regime falls back to a good-practice target
// the screen labels as practice. Filling the rest with a plausible-looking 30
// would print a developer's guess to a DPO as though it were their law.
//
// That is the same restraint the breach clock already shows: of the regimes in
// the catalogue only THREE carry an hours-based notification deadline, and the
// others are explicitly "no fixed period" or "unknown" rather than filled in to
// make the table look complete. (I asserted five of them from memory when
// writing this and the data said otherwise — hence the list below is read from
// the catalogue rather than typed.)
// =============================================================================

import {
  subjectRequestTarget,
  DEFAULT_SUBJECT_REQUEST_TARGET_DAYS,
  complianceProfile,
  COMPLIANCE_PROFILES,
} from "@sms/types";
import { PrivacyService } from "../../src/privacy/privacy.service";
import type { Principal, TenantContext, TenantTx } from "../../src/integrity/integrity.foundation";

const DAY = 86_400_000;
const REVIEWER: Principal = {
  schoolId: "A",
  userId: "dpo-1",
  roles: ["principal"],
  permissions: ["privacy.erasure.review"],
};

function make(rows: Array<Record<string, unknown>>, compliance: string | null = "GDPR") {
  const tx = { erasureRequest: { findMany: jest.fn().mockResolvedValue(rows) } } as unknown as TenantTx;
  const s = Object.create(PrivacyService.prototype) as PrivacyService;
  Object.assign(s, {
    db: { runAsTenant: jest.fn(async (_c: TenantContext, fn: (t: TenantTx) => unknown) => fn(tx)) },
    region: { forSchool: async () => ({ compliance }) },
  });
  return { s, tx };
}
const daysAgo = (n: number) => new Date(Date.now() - n * DAY);
const row = (over: Record<string, unknown> = {}) => ({
  id: "e1", studentId: "s1", reason: "r", status: "PENDING", createdAt: daysAgo(0), ...over,
});

describe("a pending request", () => {
  it("says how many days are left", async () => {
    const [r] = await make([row({ createdAt: daysAgo(10) })]).s.listErasureRequests(REVIEWER);
    expect(r.daysRemaining).toBe(20); // 30-day GDPR period, 10 gone
    expect(r.overdue).toBe(false);
    expect(r.targetDays).toBe(30);
  });

  it("is OVERDUE once the period has passed", async () => {
    const [r] = await make([row({ createdAt: daysAgo(31) })]).s.listErasureRequests(REVIEWER);
    expect(r.overdue).toBe(true);
    expect(r.daysRemaining).toBeLessThan(0);
  });

  it("dates the deadline from when the request ARRIVED", async () => {
    const created = daysAgo(5);
    const [r] = await make([row({ createdAt: created })]).s.listErasureRequests(REVIEWER);
    expect(r.dueAt.getTime()).toBe(created.getTime() + 30 * DAY);
  });
});

describe("a request that has been answered", () => {
  it.each([["APPROVED"], ["REJECTED"]])("%s stops the clock rather than ticking on", async (status) => {
    // A register whose answered rows keep counting down teaches its reader to
    // ignore the column.
    const [r] = await make([row({ status, createdAt: daysAgo(400) })]).s.listErasureRequests(REVIEWER);
    expect(r.daysRemaining).toBeNull();
    expect(r.overdue).toBe(false);
  });
});

describe("whether the date is the law", () => {
  it("is statutory for a regime whose period is recorded", () => {
    const t = subjectRequestTarget("GDPR");
    expect(t).toEqual({ days: 30, statutory: true });
    expect(complianceProfile("GDPR").subjectRequest).toEqual({ kind: "days", days: 30 });
  });

  it("is PRACTICE, not law, for a regime whose period is not", async () => {
    // The property the whole design turns on. Nigeria's NDPR has its breach
    // period recorded and its subject-request period deliberately not, so the
    // school still gets a useful countdown that does not claim to be their law.
    const t = subjectRequestTarget("NDPR");
    expect(t.statutory).toBe(false);
    expect(t.days).toBe(DEFAULT_SUBJECT_REQUEST_TARGET_DAYS);
    const [r] = await make([row()], "NDPR").s.listErasureRequests(REVIEWER);
    expect(r.deadlineIsStatutory).toBe(false);
  });

  it("is practice for a school with no regime set at all", async () => {
    const [r] = await make([row()], null).s.listErasureRequests(REVIEWER);
    expect(r.deadlineIsStatutory).toBe(false);
    expect(r.targetDays).toBe(DEFAULT_SUBJECT_REQUEST_TARGET_DAYS);
  });

  it("never marks a regime statutory just because its BREACH period is known", () => {
    // The trap this guards: 25 regimes have a researched breach deadline, and
    // reusing that as evidence of a subject-request deadline would mark almost
    // every school's countdown as law on the strength of a different rule.
    const withBreachHours = Object.keys(COMPLIANCE_PROFILES).filter(
      (k) => complianceProfile(k).breachNotify.kind === "hours",
    );
    expect(withBreachHours.length).toBeGreaterThan(1); // the scan found some
    for (const k of withBreachHours) {
      if (k === "GDPR") continue; // the one that IS recorded
      expect(subjectRequestTarget(k).statutory).toBe(false);
    }
  });
});

describe("the reviewer's scope, unchanged", () => {
  it("a requester without review permission sees only their own", async () => {
    const { s, tx } = make([row()]);
    await s.listErasureRequests({ ...REVIEWER, permissions: [] });
    expect((tx.erasureRequest.findMany as jest.Mock).mock.calls[0][0].where).toEqual({ requestedById: "dpo-1" });
  });
});
