// =============================================================================
// OperatorAttentionService — the queue that decides what the owner looks at
// =============================================================================
// A queue is only useful if it is trusted, and it stops being trusted the first
// time it cries wolf across the whole fleet. So the cases that matter most here are
// the SUPPRESSION ones: a healthy school produces no row, a failed probe produces
// no accusation, and a dormant school is not also reported for not taking registers.
// =============================================================================

import { OperatorAttentionService } from "../../src/operator/operator-attention.service";
import type { Principal } from "../../src/integrity/integrity.foundation";

const owner: Principal = { schoolId: "PLAT", userId: "owner", roles: ["super_admin"], permissions: [] };

const A = "aaaaaaaa-1111-1111-1111-111111111111"; // healthy
const B = "bbbbbbbb-2222-2222-2222-222222222222"; // past due
const C = "cccccccc-3333-3333-3333-333333333333"; // dormant

const day = (n: number) => new Date(Date.now() + n * 86_400_000);

/**
 * @param opts.probesThrow makes the activity/register probes fail, which is the
 *   case that used to flag the ENTIRE fleet as dormant.
 */
function makeService(opts: { probesThrow?: boolean } = {}) {
  const client = {
    school: {
      findMany: jest.fn().mockResolvedValue([
        { id: A, name: "Alpha College" },
        { id: B, name: "Beta Academy" },
        { id: C, name: "Gamma School" },
      ]),
    },
    schoolSubscription: {
      findMany: jest.fn().mockResolvedValue([
        { schoolId: A, plan: "PREMIUM", status: "ACTIVE", currentPeriodEnd: day(60), graceDays: null, seats: 800, seatArrearsMinor: 0 },
        { schoolId: B, plan: "PREMIUM", status: "PAST_DUE", currentPeriodEnd: day(-9), graceDays: null, seats: 500, seatArrearsMinor: 0 },
        { schoolId: C, plan: "STANDARD", status: "ACTIVE", currentPeriodEnd: day(90), graceDays: null, seats: 100, seatArrearsMinor: 0 },
      ]),
    },
    $queryRaw: jest.fn(async (q: unknown) => {
      const sql = JSON.stringify(q);
      if (sql.includes("audit_log")) {
        if (opts.probesThrow) throw new Error("probe failed");
        return [{ schoolId: A }, { schoolId: B }]; // C is silent -> dormant
      }
      if (sql.includes("attendance_session")) {
        if (opts.probesThrow) throw new Error("probe failed");
        return [{ schoolId: A }]; // B took no registers
      }
      if (sql.includes("school_admin")) {
        return [{ schoolId: A, admins: 2 }, { schoolId: B, admins: 1 }, { schoolId: C, admins: 1 }];
      }
      // headcountBySchool
      return [
        { schoolId: A, students: 800, staff: 60, parents: 700 },
        { schoolId: B, students: 500, staff: 40, parents: 430 },
        { schoolId: C, students: 100, staff: 9, parents: 90 },
      ];
    }),
  };
  const svc = new OperatorAttentionService(
    {} as never,
    { record: jest.fn() } as never,
    { client } as never,
  );
  return { svc, client };
}

describe("OperatorAttentionService.queue", () => {
  it("lists only schools that need a decision — a healthy school produces no row", async () => {
    const { svc } = makeService();
    const out = await svc.queue(owner);
    const names = out.rows.map((r) => r.schoolName);

    expect(names).not.toContain("Alpha College"); // paying, active, taking registers
    expect(names).toContain("Beta Academy");
    expect(names).toContain("Gamma School");
    expect(out.scanned).toBe(3);
  });

  it("ranks the worst first, then by what is at stake", async () => {
    const { svc } = makeService();
    const out = await svc.queue(owner);
    expect(out.rows[0].severity).toBe(3);
    // Both are severity 3 here, so money breaks the tie — the order somebody would
    // actually work through them in.
    expect(out.rows[0].mrrMinor).toBeGreaterThanOrEqual(out.rows[1].mrrMinor);
  });

  it("does not report a dormant school for also not taking registers", async () => {
    // One problem, reported once. Gamma is dormant; saying it also stopped taking
    // registers is the same fact twice and pads a queue meant to be short.
    const { svc } = makeService();
    const out = await svc.queue(owner);
    const gamma = out.rows.find((r) => r.schoolName === "Gamma School")!;
    const kinds = gamma.signals.map((s) => s.kind);
    expect(kinds).toContain("DORMANT");
    expect(kinds).not.toContain("REGISTERS_STOPPED");
  });

  it("flags a live school that has stopped taking registers", async () => {
    const { svc } = makeService();
    const out = await svc.queue(owner);
    const beta = out.rows.find((r) => r.schoolName === "Beta Academy")!;
    expect(beta.signals.map((s) => s.kind)).toEqual(expect.arrayContaining(["PAST_DUE", "REGISTERS_STOPPED"]));
    // The number is in the text, so the row is actionable without a drill-down.
    expect(beta.signals.find((s) => s.kind === "PAST_DUE")!.detail).toMatch(/9 days/);
  });

  it("says whether a past-due school is still in grace or already downgraded", async () => {
    // This distinction is load-bearing: it is the one thing the console's red banner
    // carried that the queue did not, and reducing that banner to a single line is
    // only safe because it lives here now. "Chase the payment" and "their modules
    // are already gone" are two different phone calls.
    const { svc, client } = makeService();

    // 9 days over, generous 30-day grace -> still in the window.
    client.schoolSubscription.findMany.mockResolvedValue([
      { schoolId: B, plan: "PREMIUM", status: "PAST_DUE", currentPeriodEnd: day(-9), graceDays: 30, seats: 500, seatArrearsMinor: 0 },
    ]);
    let out = await svc.queue(owner);
    expect(out.rows.find((r) => r.schoolName === "Beta Academy")!.signals.find((s) => s.kind === "PAST_DUE")!.detail)
      .toMatch(/grace window/);

    // Same 9 days, 3-day grace -> the plan has actually dropped.
    client.schoolSubscription.findMany.mockResolvedValue([
      { schoolId: B, plan: "PREMIUM", status: "PAST_DUE", currentPeriodEnd: day(-9), graceDays: 3, seats: 500, seatArrearsMinor: 0 },
    ]);
    out = await svc.queue(owner);
    expect(out.rows.find((r) => r.schoolName === "Beta Academy")!.signals.find((s) => s.kind === "PAST_DUE")!.detail)
      .toMatch(/downgraded/);
  });

  it("a FAILED probe accuses nobody", async () => {
    // The bug this exists for: the probes drive NEGATIVE signals — a school is
    // dormant because it is ABSENT from the result — so returning an empty set on
    // failure would flag every school in the fleet as dormant and bury the real
    // ones. Unknown must suppress, not accuse.
    const { svc } = makeService({ probesThrow: true });
    const out = await svc.queue(owner);
    const kinds = out.rows.flatMap((r) => r.signals.map((s) => s.kind));
    expect(kinds).not.toContain("DORMANT");
    expect(kinds).not.toContain("REGISTERS_STOPPED");
    // The money signals are unaffected — a broken probe must not blind the queue.
    expect(kinds).toContain("PAST_DUE");
  });

  it("counts signals across the WHOLE fleet, not just the returned page", async () => {
    const { svc } = makeService();
    const out = await svc.queue(owner);
    const flagged = out.rows.length;
    expect(out.total).toBe(flagged);
    expect(out.shown).toBe(flagged);
    // byKind is the fleet tally — the recurring defect in this codebase has been a
    // headline measured off a capped list.
    expect(out.byKind.PAST_DUE).toBe(1);
    expect(out.byKind.DORMANT).toBe(1);
  });

  it("503s rather than guessing when the privileged client is absent", async () => {
    const svc = new OperatorAttentionService({} as never, { record: jest.fn() } as never, { client: null } as never);
    await expect(svc.queue(owner)).rejects.toThrow(/not configured/i);
  });
});
