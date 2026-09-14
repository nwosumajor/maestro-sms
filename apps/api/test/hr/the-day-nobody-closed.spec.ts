// =============================================================================
// Absence was never recorded, so the register could not be wrong — only empty
// =============================================================================
// `summary()` counts the rows that EXIST. A member of staff who simply never
// clocked in had NO row, so they were neither present nor absent: the register
// said "unmarked" and the month's roll-up counted nothing at all.
//
// Absence was therefore recorded only where a human marked each absentee by
// hand — which on a kiosk or biometric school nobody does. So the absence figure
// was structurally near zero, and everything drawn from it inherited that: the
// HR analytics card, a lateness conversation, a disciplinary file.
//
// The PUPIL register was given a reminder sweep and a nightly rollup for exactly
// this failure. The staff register had no scheduled job of any kind.
//
// AND AUTHORISED ABSENCE WAS THE SAME STATE AS A NO-SHOW. Nothing wrote
// attendance from an approved leave request, so somebody on approved leave was
// indistinguishable from somebody who did not turn up — and marking them ABSENT
// counted their own approved leave against them.
// =============================================================================

import { StaffDayCloseService } from "../../src/hr/staff-day-close.service";

const LAGOS = { id: "s1", name: "Demo", country: "NG", timezone: "Africa/Lagos" };

/** 19:00 in Lagos (UTC+1) on a Wednesday — the closing tick. */
const CLOSING_TICK = new Date("2026-08-19T18:00:00.000Z");
/** 09:00 Lagos the same day — any other hour. */
const MORNING_TICK = new Date("2026-08-19T08:00:00.000Z");
/** 19:00 Lagos on a SATURDAY. */
const WEEKEND_TICK = new Date("2026-08-22T18:00:00.000Z");

function makeService(opts: {
  schools?: typeof LAGOS[];
  staff?: string[];
  marks?: Array<{ userId: string; clockInAt: Date | null; clockOutAt: Date | null }>;
  leave?: string[];
  holiday?: boolean;
  throwFor?: string;
} = {}) {
  const { staff = ["a", "b"], marks = [], leave = [], holiday = false } = opts;
  const created: Array<{ userId: string; status: string; source: string; note: string | null }> = [];
  const client = {
    school: { findMany: jest.fn(async () => opts.schools ?? [LAGOS]) },
    schoolHoliday: { findFirst: jest.fn(async () => (holiday ? { id: "h" } : null)) },
    employee: {
      findMany: jest.fn(async ({ where }: { where: { schoolId: string } }) => {
        if (opts.throwFor === where.schoolId) throw new Error("boom");
        return staff.map((userId) => ({ userId }));
      }),
    },
    staffAttendance: {
      findMany: jest.fn(async () => marks.map((m, i) => ({ id: `m${i}`, status: "PRESENT", ...m }))),
      create: jest.fn(async ({ data }: { data: { userId: string; status: string; source: string; note: string | null } }) => {
        created.push(data);
        return data;
      }),
    },
    leaveRequest: { findMany: jest.fn(async () => leave.map((userId) => ({ userId }))) },
    auditLog: { create: jest.fn(async () => ({})) },
  };
  const svc = new StaffDayCloseService({ client } as never);
  return { svc, created, client };
}

beforeEach(() => jest.useFakeTimers({ doNotFake: ["setTimeout", "setInterval", "clearTimeout", "clearInterval"] }));
afterEach(() => {
  // CLEARED, not merely switched off: a residual handle keeps the jest worker
  // alive and force-exits it — and only when another file runs after this one in
  // the same worker, which is what makes it intermittent and invisible.
  jest.clearAllTimers();
  jest.useRealTimers();
});

describe("closing the staff day", () => {
  it("records an ABSENCE nobody would otherwise have recorded", async () => {
    jest.setSystemTime(CLOSING_TICK);
    const { svc, created } = makeService({ staff: ["a", "b"] });
    const r = await svc.run();
    expect(r.absent).toBe(2);
    expect(created.every((c) => c.source === "SYSTEM")).toBe(true);
  });

  it("marks approved leave ON_LEAVE, not absent", async () => {
    // The whole point: "authorised" and "did not turn up" were one state.
    jest.setSystemTime(CLOSING_TICK);
    const { svc, created } = makeService({ staff: ["a", "b"], leave: ["b"] });
    const r = await svc.run();
    expect(r.absent).toBe(1);
    expect(r.onLeave).toBe(1);
    expect(created.find((c) => c.userId === "b")!.status).toBe("ON_LEAVE");
  });

  it("NEVER overwrites somebody who actually scanned", async () => {
    // A human mark or a real scan outranks anything inferred from silence.
    jest.setSystemTime(CLOSING_TICK);
    const { svc, created } = makeService({
      staff: ["a", "b"],
      marks: [{ userId: "a", clockInAt: new Date(), clockOutAt: new Date() }],
    });
    const r = await svc.run();
    expect(r.absent).toBe(1);
    expect(created.map((c) => c.userId)).toEqual(["b"]);
  });

  it("counts a day left OPEN separately — not as an absence and not as a failure", async () => {
    // Clocked in, never clocked out. It is the one thing here a human should
    // look at, and folding it into either number would hide it.
    jest.setSystemTime(CLOSING_TICK);
    const { svc } = makeService({
      staff: ["a"],
      marks: [{ userId: "a", clockInAt: new Date(), clockOutAt: null }],
    });
    const r = await svc.run();
    expect(r.openSpans).toBe(1);
    expect(r.absent).toBe(0);
    expect(r.failed).toBe(0);
  });
});

describe("what it correctly refuses to do", () => {
  it("does nothing on any hour but the school's own evening", async () => {
    // A fleet spans timezones: there is no single instant that is after school
    // everywhere, so 23 ticks in 24 must do nothing per school.
    jest.setSystemTime(MORNING_TICK);
    const { svc, created } = makeService();
    const r = await svc.run();
    expect(r.schools).toBe(0);
    expect(r.skipped).toBe(1);
    expect(created).toEqual([]);
  });

  it("does not mark a whole school absent on a non-school day", async () => {
    jest.setSystemTime(WEEKEND_TICK);
    const { svc, created } = makeService();
    const r = await svc.run();
    expect(r.skipped).toBe(1);
    expect(created).toEqual([]);
  });

  it("does not mark a whole school absent on a declared holiday", async () => {
    jest.setSystemTime(CLOSING_TICK);
    const { svc, created } = makeService({ holiday: true });
    const r = await svc.run();
    expect(r.skipped).toBe(1);
    expect(created).toEqual([]);
  });
});

describe("one school's failure does not end the fleet's sweep", () => {
  it("NAMES it in the count rather than throwing", async () => {
    // A cross-tenant sweep that catches per school does not throw, so `lastOk`
    // stays true and every other signal reads clean — the count is the only
    // thing that can say a school was skipped.
    jest.setSystemTime(CLOSING_TICK);
    const bad = { ...LAGOS, id: "s2", name: "Broken" };
    const { svc } = makeService({ schools: [LAGOS, bad], throwFor: "s2", staff: ["a"] });
    const r = await svc.run();
    expect(r.failed).toBe(1);
    expect(r.absent).toBe(1); // the healthy school was still done
  });

  it("is disabled, not broken, without a privileged database URL", async () => {
    const svc = new StaffDayCloseService({ client: null } as never);
    const r = await svc.run();
    expect(r).toMatchObject({ schools: 0, absent: 0, failed: 0 });
  });
});
