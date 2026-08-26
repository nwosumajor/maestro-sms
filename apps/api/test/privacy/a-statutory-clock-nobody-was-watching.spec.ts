// =============================================================================
// A statutory clock that nobody was watching
// =============================================================================
// The breach register computed `notifyDueAt` / `hoursRemaining` / `overdue`
// only when somebody opened /admin/compliance. This platform runs seventeen
// scheduled sweeps — it reminds HR that a staff certificate expires in THIRTY
// DAYS — and the one deadline written in law, 72 hours from becoming aware
// (Art. 33(1)), had no sweep at all.
// =============================================================================

import { BreachDeadlineService } from "../../src/privacy/breach-deadline.service";
import { breachClock, breachNoticeStage, BREACH_WARN_HOURS } from "../../src/privacy/breach-clock";

const HOUR = 3_600_000;
const SCHOOL = "school-a";

function incident(over: Partial<Record<string, unknown>> = {}) {
  return {
    id: "b1",
    schoolId: SCHOOL,
    title: "Laptop left on a train",
    // 80 hours into a 72-hour window: past the deadline, not approaching it.
    discoveredAt: new Date(Date.now() - 80 * HOUR),
    status: "OPEN",
    riskLevel: "HIGH",
    notifiedAuthorityAt: null,
    notifiedSubjectsAt: null,
    noNotificationReason: null,
    deadlineNoticeStage: null,
    ...over,
  };
}

function makeService(rows: Array<Record<string, unknown>>, opts: { throwFor?: string } = {}) {
  const notices: Array<Record<string, unknown>> = [];
  const stamped: Array<{ id: string; stage: unknown }> = [];
  const client = {
    dataBreachIncident: {
      findMany: jest.fn().mockResolvedValue(rows),
      update: jest.fn(async (a: { where: { id: string }; data: { deadlineNoticeStage: string } }) => {
        stamped.push({ id: a.where.id, stage: a.data.deadlineNoticeStage });
        return {};
      }),
    },
  };
  const svc = new BreachDeadlineService(
    { client } as never,
    {
      notifyPermissionHolders: jest.fn(async (_c: unknown, _p: string, n: Record<string, unknown>) => {
        notices.push(n);
        return 1;
      }),
    } as never,
    {
      forSchool: jest.fn(async (schoolId: string) => {
        if (opts.throwFor === schoolId) throw new Error("region lookup exploded");
        return { compliance: "GDPR" };
      }),
    } as never,
  );
  return { svc, notices, stamped, client };
}

describe("the clock itself, shared with the screen", () => {
  it("is the SAME function the register renders from", () => {
    // Two definitions of "late" is the one thing this register cannot afford —
    // ComplianceService.clockFor now delegates here.
    const src = require("node:fs").readFileSync(
      require("node:path").join(__dirname, "..", "..", "src", "privacy", "compliance.service.ts"),
      "utf8",
    );
    expect(src).toMatch(/return breachClock\(r, now, regime\)/);
  });

  it("says nothing about an incident with hours to spare", () => {
    const r = incident({ discoveredAt: new Date(Date.now() - 2 * HOUR) });
    expect(breachNoticeStage(r as never, breachClock(r as never, new Date(), "GDPR"))).toBeNull();
  });

  it("warns inside the final window", () => {
    const r = incident({ discoveredAt: new Date(Date.now() - (72 - BREACH_WARN_HOURS + 1) * HOUR) });
    expect(breachNoticeStage(r as never, breachClock(r as never, new Date(), "GDPR"))).toBe("APPROACHING");
  });

  it("is silent once a REASON for not notifying is recorded — Art. 33(1) allows that", () => {
    const r = incident({ noNotificationReason: "Encrypted at rest; no risk to the people." });
    expect(breachNoticeStage(r as never, breachClock(r as never, new Date(), "GDPR"))).toBeNull();
  });

  it("is silent once the authority HAS been told", () => {
    const r = incident({ notifiedAuthorityAt: new Date() });
    expect(breachNoticeStage(r as never, breachClock(r as never, new Date(), "GDPR"))).toBeNull();
  });

  it("says nothing about a CLOSED incident, however old", () => {
    const r = incident({ status: "CLOSED", discoveredAt: new Date(Date.now() - 900 * HOUR) });
    expect(breachNoticeStage(r as never, breachClock(r as never, new Date(), "GDPR"))).toBeNull();
  });

  it("does not chase Art. 34 on a timer", () => {
    // "Without undue delay" fixes no hour count, and inventing one would put a
    // deadline in a notice that the law does not set.
    const r = incident({ notifiedAuthorityAt: new Date(), notifiedSubjectsAt: null, riskLevel: "HIGH" });
    const clock = breachClock(r as never, new Date(), "GDPR");
    expect(clock.subjectsUnnotified).toBe(true);
    expect(breachNoticeStage(r as never, clock)).toBeNull();
  });
});

describe("the sweep", () => {
  it("tells the people who can act, once, when the deadline has passed", async () => {
    const t = makeService([incident()]);
    const out = await t.svc.sweep();
    expect(out).toMatchObject({ scanned: 1, overdue: 1, warned: 0, failed: 0 });
    expect(String(t.notices[0].title)).toMatch(/PAST its statutory deadline/);
    expect(t.stamped).toEqual([{ id: "b1", stage: "OVERDUE" }]);
  });

  it("does not say it again on the next run", async () => {
    // Hourly. A notice per hour is one people learn to ignore, including on the
    // incident where it mattered.
    const t = makeService([incident({ deadlineNoticeStage: "OVERDUE" })]);
    const out = await t.svc.sweep();
    expect(t.notices).toEqual([]);
    expect(out).toMatchObject({ overdue: 0, warned: 0 });
  });

  it("DOES escalate from a warning to an overdue notice", async () => {
    const t = makeService([incident({ deadlineNoticeStage: "APPROACHING" })]);
    await t.svc.sweep();
    expect(String(t.notices[0].title)).toMatch(/PAST its/);
    expect(t.stamped).toEqual([{ id: "b1", stage: "OVERDUE" }]);
  });

  it("calls it a target, not a deadline, where the law is not modelled", async () => {
    // The same honesty `deadlineIsStatutory` carries to the screen.
    const t = makeService([incident()]);
    (t.svc as unknown as { region: { forSchool: jest.Mock } }).region.forSchool = jest
      .fn()
      .mockResolvedValue({ compliance: "NONE" });
    await t.svc.sweep();
    expect(String(t.notices[0].title)).toMatch(/PAST its target/);
    expect(String(t.notices[0].title)).not.toMatch(/statutory/);
  });

  it("one school's failure does not end the run, and is COUNTED", async () => {
    // The lesson this repo has recorded three times. The operator's jobs
    // console reads `failed` to decide whether a run was healthy.
    const t = makeService(
      [incident(), incident({ id: "b2", schoolId: "school-b" })],
      { throwFor: SCHOOL },
    );
    const out = await t.svc.sweep();
    expect(out.failed).toBe(1);
    expect(out.overdue).toBe(1); // school-b was still handled
    expect(t.stamped).toEqual([{ id: "b2", stage: "OVERDUE" }]);
  });

  it("does nothing at all without the privileged database", async () => {
    const svc = new BreachDeadlineService({ client: null } as never, {} as never, {} as never);
    await expect(svc.sweep()).resolves.toMatchObject({ skipped: "NO_DB", failed: 0 });
  });
});
