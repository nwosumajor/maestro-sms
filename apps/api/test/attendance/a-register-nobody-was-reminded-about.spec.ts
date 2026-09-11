// =============================================================================
// The register nobody took, and nobody was told about
// =============================================================================
// An unrecorded absence is indistinguishable from a pupil who was present, and
// after seven days correcting one needs a second member of staff to approve the
// amendment. So a register that was never taken is worth catching on the day —
// and nothing did. The ONLY attendance notification the platform sent went to
// GUARDIANS, about a child already marked absent. The teacher who had marked
// nobody at all heard nothing.
//
// This is the sweep that tells them, and the rules it has to obey are the ones
// this repo has already paid for elsewhere:
//
//   - "today" is the SCHOOL's day, and the reminder hour is the SCHOOL's hour —
//     one UTC instant is 14:00 in Lagos and 09:00 in Toronto;
//   - count the TEACHERS TOLD, not the registers iterated;
//   - address only somebody who is STILL HERE;
//   - name what could not be done (`unreachable`) rather than folding it into a
//     number that reads as normal;
//   - catch PER SCHOOL and count it, so one school's failure does not end the
//     fleet's sweep.
// =============================================================================

import { RegisterReminderService, REGISTER_REMINDER_LOCAL_HOUR } from "../../src/attendance/register-reminder.service";

type Cls = { id: string; name: string; supervisorId: string | null };

interface World {
  timezone: string;
  classes: Cls[];
  /** Class ids that already have a register for the day. */
  taken: string[];
  /** Class ids with nobody on roll. */
  empty?: string[];
  /** Users who are not ACTIVE. */
  departed?: string[];
  term?: { startDate: Date | null; endDate: Date | null } | null;
  throws?: boolean;
}

function makeService(world: World, opts: { now?: Date } = {}) {
  const sent: Array<{ recipientId: string; type: string; title: string; classes: string[] }> = [];
  const school = { id: "S1", name: "Focus", country: null as string | null, timezone: world.timezone };

  const client = {
    school: {
      findMany: jest.fn(async (_args: { where?: Record<string, unknown> }) => [school]),
    },
    term: {
      findFirst: jest.fn(async () =>
        world.term === undefined ? { startDate: null, endDate: null } : world.term,
      ),
    },
    class: {
      findMany: jest.fn(async () => {
        if (world.throws) throw new Error("boom");
        return world.classes;
      }),
    },
    attendanceSession: {
      findMany: jest.fn(async () => world.taken.map((classId) => ({ classId }))),
    },
    enrollment: {
      groupBy: jest.fn(async () =>
        world.classes
          .filter((c) => !(world.empty ?? []).includes(c.id))
          .map((c) => ({ classId: c.id, _count: { _all: 25 } })),
      ),
    },
    user: {
      findMany: jest.fn(async ({ where }: { where: { id: { in: string[] } } }) =>
        where.id.in.filter((id) => !(world.departed ?? []).includes(id)).map((id) => ({ id })),
      ),
    },
  };

  const notifications = {
    enqueue: jest.fn(async (_ctx: unknown, input: { recipientId: string; type: string; title: string; data?: { classes?: string[] } }) => {
      sent.push({ recipientId: input.recipientId, type: input.type, title: input.title, classes: input.data?.classes ?? [] });
    }),
  };

  if (opts.now) jest.setSystemTime(opts.now);
  const svc = new RegisterReminderService({ client } as never, notifications as never);
  return { svc, sent, client, notifications };
}

/** An instant that is `hour` local time in the given zone, on a Wednesday. */
function localAt(tz: string, hour: number, day = "2026-09-09"): Date {
  for (let utc = 0; utc < 48; utc += 1) {
    const at = new Date(`${day}T${String(utc % 24).padStart(2, "0")}:10:00.000Z`);
    const got = new Intl.DateTimeFormat("en-GB", { timeZone: tz, hour: "2-digit", hour12: false }).format(at);
    if (Number(got) === hour) return at;
  }
  throw new Error(`no UTC hour maps to ${hour} in ${tz}`);
}

beforeEach(() => {
  jest.useFakeTimers();
});
afterEach(() => {
  // CLEARED, not merely switched off: a lingering fake timer keeps the worker
  // alive and jest force-exits it, intermittently and only when another file
  // runs after this one in the same worker.
  jest.clearAllTimers();
  jest.useRealTimers();
});

describe("the reminder fires on the SCHOOL's clock", () => {
  it("acts when the school's own afternoon arrives", async () => {
    const { svc, sent } = makeService(
      { timezone: "Africa/Lagos", classes: [{ id: "c1", name: "JSS1A", supervisorId: "t1" }], taken: [] },
      { now: localAt("Africa/Lagos", REGISTER_REMINDER_LOCAL_HOUR) },
    );
    const r = await svc.run();
    expect(r.schools).toBe(1);
    expect(sent).toHaveLength(1);
    expect(sent[0].recipientId).toBe("t1");
    expect(sent[0].type).toBe("ATTENDANCE_REGISTER_DUE");
  });

  it("does NOT act at the same instant for a school in another zone", async () => {
    // The whole reason a daily reminder needs an hourly sweep: this instant is
    // mid-afternoon in Lagos and the small hours in Auckland.
    const at = localAt("Africa/Lagos", REGISTER_REMINDER_LOCAL_HOUR);
    const { svc, sent } = makeService(
      { timezone: "Pacific/Auckland", classes: [{ id: "c1", name: "JSS1A", supervisorId: "t1" }], taken: [] },
      { now: at },
    );
    const r = await svc.run();
    expect(r.schools).toBe(0);
    expect(sent).toEqual([]);
  });

  it("does nothing on the twenty-three other ticks", async () => {
    const wrongHour = (REGISTER_REMINDER_LOCAL_HOUR + 3) % 24;
    const { svc, sent } = makeService(
      { timezone: "Africa/Lagos", classes: [{ id: "c1", name: "JSS1A", supervisorId: "t1" }], taken: [] },
      { now: localAt("Africa/Lagos", wrongHour) },
    );
    expect((await svc.run()).schools).toBe(0);
    expect(sent).toEqual([]);
  });
});

describe("it does not nag on a day there is no register to take", () => {
  it("skips the weekend", async () => {
    const { svc, sent } = makeService(
      { timezone: "Africa/Lagos", classes: [{ id: "c1", name: "JSS1A", supervisorId: "t1" }], taken: [] },
      { now: localAt("Africa/Lagos", REGISTER_REMINDER_LOCAL_HOUR, "2026-09-12") }, // Saturday
    );
    const r = await svc.run();
    expect(r.skipped).toBe(1);
    expect(sent).toEqual([]);
  });

  it("skips a school between terms", async () => {
    const { svc, sent } = makeService(
      {
        timezone: "Africa/Lagos",
        classes: [{ id: "c1", name: "JSS1A", supervisorId: "t1" }],
        taken: [],
        term: { startDate: new Date("2026-01-05"), endDate: new Date("2026-03-27") },
      },
      { now: localAt("Africa/Lagos", REGISTER_REMINDER_LOCAL_HOUR) },
    );
    expect((await svc.run()).skipped).toBe(1);
    expect(sent).toEqual([]);
  });

  it("does not count an EMPTY class as an outstanding register", async () => {
    const { svc, sent } = makeService(
      {
        timezone: "Africa/Lagos",
        classes: [{ id: "c1", name: "JSS1A", supervisorId: "t1" }],
        taken: [],
        empty: ["c1"],
      },
      { now: localAt("Africa/Lagos", REGISTER_REMINDER_LOCAL_HOUR) },
    );
    expect((await svc.run()).outstanding).toBe(0);
    expect(sent).toEqual([]);
  });

  it("says nothing to a teacher who HAS taken theirs", async () => {
    const { svc, sent } = makeService(
      {
        timezone: "Africa/Lagos",
        classes: [
          { id: "c1", name: "JSS1A", supervisorId: "t1" },
          { id: "c2", name: "JSS1B", supervisorId: "t2" },
        ],
        taken: ["c1"],
      },
      { now: localAt("Africa/Lagos", REGISTER_REMINDER_LOCAL_HOUR) },
    );
    await svc.run();
    expect(sent.map((s) => s.recipientId)).toEqual(["t2"]);
  });
});

describe("it counts the people it told, not the rows it walked", () => {
  it("ONE message per teacher, naming all their classes", async () => {
    // Three separate messages about three registers is the shape people mute.
    const { svc, sent } = makeService(
      {
        timezone: "Africa/Lagos",
        classes: [
          { id: "c1", name: "JSS1A", supervisorId: "t1" },
          { id: "c2", name: "JSS1B", supervisorId: "t1" },
          { id: "c3", name: "JSS1C", supervisorId: "t1" },
        ],
        taken: [],
      },
      { now: localAt("Africa/Lagos", REGISTER_REMINDER_LOCAL_HOUR) },
    );
    const r = await svc.run();
    expect(sent).toHaveLength(1);
    expect(sent[0].classes).toEqual(["JSS1A", "JSS1B", "JSS1C"]);
    // THREE registers outstanding, ONE teacher reminded. Counting the registers
    // would report three people told when one was.
    expect(r.outstanding).toBe(3);
    expect(r.notified).toBe(1);
  });
});

describe("it names what it could not do", () => {
  it("a class with NO teacher is unreachable, not silently skipped", async () => {
    const { svc, sent } = makeService(
      {
        timezone: "Africa/Lagos",
        classes: [{ id: "c1", name: "JSS1A", supervisorId: null }],
        taken: [],
      },
      { now: localAt("Africa/Lagos", REGISTER_REMINDER_LOCAL_HOUR) },
    );
    const r = await svc.run();
    expect(r.outstanding).toBe(1);
    expect(r.unreachable).toBe(1);
    expect(r.notified).toBe(0);
    expect(sent).toEqual([]);
  });

  it("a teacher who has LEFT is unreachable — addressing a leaver is addressing nobody", async () => {
    const { svc, sent } = makeService(
      {
        timezone: "Africa/Lagos",
        classes: [{ id: "c1", name: "JSS1A", supervisorId: "gone" }],
        taken: [],
        departed: ["gone"],
      },
      { now: localAt("Africa/Lagos", REGISTER_REMINDER_LOCAL_HOUR) },
    );
    const r = await svc.run();
    expect(r.unreachable).toBe(1);
    expect(r.notified).toBe(0);
    expect(sent).toEqual([]);
  });

  it("a school that THROWS is counted, and does not end the sweep", async () => {
    const { svc } = makeService(
      { timezone: "Africa/Lagos", classes: [], taken: [], throws: true },
      { now: localAt("Africa/Lagos", REGISTER_REMINDER_LOCAL_HOUR) },
    );
    const r = await svc.run();
    expect(r.failed).toBe(1);
  });
});

describe("the manual trigger reaches ONE school", () => {
  it("passes the caller's school to the query rather than the fleet", async () => {
    const { svc, client } = makeService(
      { timezone: "Africa/Lagos", classes: [{ id: "c1", name: "JSS1A", supervisorId: "t1" }], taken: [] },
      { now: localAt("Africa/Lagos", REGISTER_REMINDER_LOCAL_HOUR) },
    );
    await svc.run({ onlySchoolId: "S1", force: true });
    const where = client.school.findMany.mock.calls[0]?.[0]?.where;
    expect(where).toMatchObject({ id: "S1" });
  });

  it("`force` works outside the reminder hour, or the button does nothing", async () => {
    const wrongHour = (REGISTER_REMINDER_LOCAL_HOUR + 5) % 24;
    const { svc, sent } = makeService(
      { timezone: "Africa/Lagos", classes: [{ id: "c1", name: "JSS1A", supervisorId: "t1" }], taken: [] },
      { now: localAt("Africa/Lagos", wrongHour) },
    );
    await svc.run({ onlySchoolId: "S1", force: true });
    expect(sent).toHaveLength(1);
  });
});

describe("with no privileged database it is a no-op, not a crash", () => {
  it("returns zeroes and sends nothing", async () => {
    const svc = new RegisterReminderService({ client: null } as never, { enqueue: jest.fn() } as never);
    const r = await svc.run();
    expect(r).toMatchObject({ schools: 0, notified: 0, failed: 0 });
  });
});
