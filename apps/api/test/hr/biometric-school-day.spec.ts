// =============================================================================
// The terminal filed every clock-in against yesterday
// =============================================================================
// Staff attendance has two capture paths into one table. The KIOSK path was
// corrected to use the school's calendar day. The BIOMETRIC device path, sitting
// beside it in the same file, still did this:
//
//     const date = new Date(`${at.toISOString().slice(0, 10)}T00:00:00.000Z`);
//
// — the server's UTC day. For a school east of UTC that is the previous day for
// the whole working morning: a Singapore terminal reporting a 07:30 arrival
// sends an instant that is 23:30 UTC the day BEFORE.
//
// What made it worse than a wrong label: the idempotency key is (userId, date).
// Filed against yesterday, the lookup finds yesterday's REAL attendance row,
// counts the event as `alreadyMarked`, and DROPS it. So the day the person
// actually worked has no record at all, and the endpoint reports success.
//
// The same instant is now asked of the school's own clock, exactly as the kiosk
// beside it does.
// =============================================================================

jest.mock("../../src/foundation/field-crypto", () => ({
  ...jest.requireActual("../../src/foundation/field-crypto"),
  decryptField: () => "device-secret",
}));
jest.mock("../../src/hr/attendance.util", () => ({
  ...jest.requireActual("../../src/hr/attendance.util"),
  verifyDeviceSignature: () => true,
  isFreshTimestamp: () => true,
}));

import { StaffAttendanceService } from "../../src/hr/attendance.service";
import type { TenantContext, TenantTx } from "../../src/integrity/integrity.foundation";

// 23:30 UTC on the 17th. In Singapore that is 07:30 on the 18th — the morning.
const ARRIVAL = "2026-08-17T23:30:00.000Z";

function makeService(timezone: string, opts: { existingDates?: string[] } = {}) {
  const { existingDates = [] } = opts;
  const created: Array<{ date: Date; status: string; clockInAt: Date }> = [];
  const tx = {
    school: { findFirst: jest.fn(async () => ({ id: "school-A" })) },
    attendanceDevice: {
      findFirst: jest.fn(async () => ({ id: "dev-1", deviceId: "D1", enabled: true, secretEnc: "enc" })),
      update: jest.fn(async () => ({})),
    },
    attendanceKiosk: { findFirst: jest.fn(async () => ({ lateAfter: "08:00" })) },
    biometricEnrollment: { findMany: jest.fn(async () => [{ deviceUserId: "E7", userId: "staff-1" }]) },
    staffAttendance: {
      findFirst: jest.fn(async (a: { where: { date: Date } }) =>
        existingDates.includes(a.where.date.toISOString().slice(0, 10)) ? { id: "existing" } : null,
      ),
      create: jest.fn(async (a: { data: { date: Date; status: string; clockInAt: Date } }) => {
        created.push(a.data);
        return a.data;
      }),
    },
  } as unknown as TenantTx;
  const db = { runAsTenant: <T>(_c: TenantContext, fn: (t: TenantTx) => Promise<T>) => fn(tx) };
  const service = new StaffAttendanceService(
    db as never,
    { record: jest.fn() } as never,
    { inTx: async () => ({ timezone }), todayInTx: async () => new Date() } as never,
  );
  const ingest = () =>
    service.ingestDeviceEvents("demo", "D1", "sig", Buffer.from("{}"), {
      timestamp: ARRIVAL,
      events: [{ deviceUserId: "E7", at: ARRIVAL }],
    });
  return { ingest, created };
}

const dayOf = (d: Date) => d.toISOString().slice(0, 10);

describe("which day a device event is filed against", () => {
  it("Singapore: the morning of the 18th, not the UTC 17th", async () => {
    // THE defect. 23:30Z is 07:30 SGT on the 18th.
    const { ingest, created } = makeService("Asia/Singapore");
    await ingest();
    expect(dayOf(created[0].date)).toBe("2026-08-18");
  });

  it("Lagos: 00:30 on the 18th is still the 18th", async () => {
    const { ingest, created } = makeService("Africa/Lagos");
    await ingest();
    expect(dayOf(created[0].date)).toBe("2026-08-18");
  });

  it("Toronto: 19:30 on the 17th stays the 17th", async () => {
    // West of UTC the same instant is still the previous day — the fix must not
    // simply shift everything forward.
    const { ingest, created } = makeService("America/Toronto");
    await ingest();
    expect(dayOf(created[0].date)).toBe("2026-08-17");
  });

  it("stores the day at UTC midnight, the form the @db.Date column wants", async () => {
    const { ingest, created } = makeService("Asia/Singapore");
    await ingest();
    expect(created[0].date.toISOString()).toBe("2026-08-18T00:00:00.000Z");
  });

  it("keeps the exact instant on clockInAt", async () => {
    // The DAY is school-local; the moment is still the moment.
    const { ingest, created } = makeService("Asia/Singapore");
    await ingest();
    expect(created[0].clockInAt.toISOString()).toBe(ARRIVAL);
  });
});

describe("the silent drop this caused", () => {
  it("no longer collides with YESTERDAY's real attendance row", async () => {
    // Yesterday (the 17th) is already marked — as it would be for anyone who
    // worked the day before. Filed against the UTC day, this event hit that row,
    // counted as `alreadyMarked`, and vanished; the 18th ended with no record
    // while the endpoint reported success.
    const { ingest, created } = makeService("Asia/Singapore", { existingDates: ["2026-08-17"] });
    const res = await ingest();
    expect(res).toMatchObject({ accepted: 1, alreadyMarked: 0 });
    expect(created).toHaveLength(1);
  });

  it("still refuses a genuine duplicate on the school's own day", async () => {
    // The idempotency itself must survive the fix.
    const { ingest, created } = makeService("Asia/Singapore", { existingDates: ["2026-08-18"] });
    const res = await ingest();
    expect(res).toMatchObject({ accepted: 0, alreadyMarked: 1 });
    expect(created).toHaveLength(0);
  });
});

describe("lateness on the same event", () => {
  it("07:30 in Singapore is PRESENT against an 08:00 boundary", async () => {
    const { ingest, created } = makeService("Asia/Singapore");
    await ingest();
    expect(created[0].status).toBe("PRESENT");
  });

  it("19:30 in Toronto is LATE against the same boundary", async () => {
    // Reading the same instant on the server's UTC clock (23:30) would also say
    // LATE — so this asserts the value, and the Singapore case above is the one
    // that separates the two readings.
    const { ingest, created } = makeService("America/Toronto");
    await ingest();
    expect(created[0].status).toBe("LATE");
  });
});
