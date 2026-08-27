// =============================================================================
// A three-stage chain approving "Leave: Annual" and nothing else
// =============================================================================
// The workflow inbox renders ONE field from a request's payload — `summary`, a
// string a service wrote — and never the raw payload, deliberately: payloads
// carry ids and a future type could put anything in there.
//
// `requestLeave` never wrote one. So head teacher -> HR manager -> principal
// were each asked to approve a request titled "Leave: Annual", with no dates, no
// day count, and no idea whether the person had the days.
//
// That matters because NOTHING ELSE CHECKS. `requestLeave` validates days > 0,
// the date order, the attachment and that the type exists — never the balance —
// and `applyFinalizedLeave` adds `lr.days` to `usedDays` with no check either.
// The control IS the human, so the human has to be able to see it.
// =============================================================================

import { LeaveService } from "../../src/hr/leave.service";

const TYPE = { id: "lt-1", name: "Annual", daysPerYear: 20 };

describe("what the approver can actually see", () => {
  it("states the length and the dates, which the title never carried", async () => {
    const { summary } = await raise({ days: 12, used: 0 });
    expect(summary).toContain("12 days");
    expect(summary).toContain("2026-06-01 → 2026-06-12");
  });

  it("states the balance, and what it becomes if they approve", async () => {
    const { summary } = await raise({ days: 12, used: 3 });
    expect(summary).toContain("3 of 20 used this year");
    expect(summary).toContain("15 if approved");
  });

  it("NAMES an over-entitlement rather than leaving it to be worked out", async () => {
    // Neither the raise nor the finalized hook refuses this — the balance simply
    // goes past the entitlement. The one fact that should change a decision is
    // therefore spelled out, not implied by two numbers.
    const { summary } = await raise({ days: 30, used: 0 });
    expect(summary).toMatch(/OVER their 20-day entitlement/);
  });

  it("says nothing about an entitlement the school has not set", async () => {
    const { summary } = await raise({ days: 5, used: 0, daysPerYear: 0 });
    expect(summary).not.toMatch(/OVER/);
  });

  it("agrees in number with a single day", async () => {
    const { summary } = await raise({ days: 1, used: 0 });
    expect(summary).toContain("1 day ·");
  });
});

async function raise(opts: { days: number; used: number; daysPerYear?: number }) {
  let payload: Record<string, unknown> = {};
  const type = { ...TYPE, daysPerYear: opts.daysPerYear ?? TYPE.daysPerYear };
  const tx = {
    leaveType: { findFirst: async () => type },
    leaveBalance: {
      findFirst: async () => ({ usedDays: opts.used, entitledDays: type.daysPerYear }),
    },
    leaveRequest: { create: async (a: { data: unknown }) => ({ id: "lr-1", ...(a.data as object) }) },
    document: { findFirst: async () => null },
  };
  const svc = Object.create(LeaveService.prototype) as LeaveService;
  Object.assign(svc, {
    db: {
      runAsTenant: async (_c: unknown, fn: (t: unknown) => unknown) => fn(tx),
      runAsTenantReadOnly: async (_c: unknown, fn: (t: unknown) => unknown) => fn(tx),
    },
    audit: { record: async () => undefined },
    workflow: {
      createRequest: async (_p: unknown, req: { payload: Record<string, unknown> }) => {
        payload = req.payload;
        return { id: "wf-1" };
      },
      submit: async () => undefined,
    },
    hooks: { onFinalized: () => undefined },
  });
  await (svc as unknown as { requestLeave: (p: unknown, i: unknown) => Promise<unknown> }).requestLeave(
    { userId: "u1", schoolId: "s1", roles: ["teacher"], permissions: [] },
    {
      leaveTypeId: "lt-1",
      startDate: "2026-06-01",
      endDate: "2026-06-12",
      days: opts.days,
      reason: "probe",
    },
  );
  return { summary: String(payload.summary ?? "") };
}
