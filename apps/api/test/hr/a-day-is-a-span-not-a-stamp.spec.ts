// =============================================================================
// The terminal was already sending the departures, and we threw them away
// =============================================================================
// `staff_attendance` held ONE row per person per day, keyed `(userId, date)`,
// carrying `clockInAt` and nothing else. The biometric ingest read that row, and
// on finding it counted the event `alreadyMarked` and dropped it:
//
//     const existing = await tx.staffAttendance.findFirst({ where: { userId, date } });
//     if (existing) { alreadyMarked++; continue; }
//
// A gate terminal reports EVERY scan. After the morning, almost everything it
// sends is somebody leaving — so the data needed to compute hours was arriving
// on a signed, authenticated, audited endpoint and going in the bin, while the
// response said the batch had been accepted.
//
// There was no clock-out anywhere else either: no column, no route, no screen,
// and no `hoursWorked` in the codebase. The system recorded arrivals.
//
// Now every scan is appended to `staff_attendance_event` and the day row is a
// PROJECTION of it — first IN, last OUT.
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

const TZ = "Africa/Lagos"; // UTC+1: these instants are all the same local day
const ARRIVAL = "2026-08-18T07:05:00.000Z";
const LUNCH = "2026-08-18T12:00:00.000Z";
const DEPARTURE = "2026-08-18T16:20:00.000Z";

function makeService() {
  // The event log, modelled as the real one behaves: append-only, and the
  // projection re-reads it. A double that returned a fixed list would prove
  // nothing about a rule that is "derive from what is stored".
  const events: Array<{ userId: string; date: string; at: Date; kind: string }> = [];
  const day: { row: { id: string; clockInAt: Date | null; clockOutAt: Date | null; status: string } | null } = { row: null };

  const tx = {
    school: { findFirst: jest.fn(async () => ({ id: "school-A" })) },
    attendanceDevice: {
      findFirst: jest.fn(async () => ({ id: "dev-1", deviceId: "D1", enabled: true, secretEnc: "enc" })),
      update: jest.fn(async () => ({})),
    },
    attendanceKiosk: { findFirst: jest.fn(async () => ({ lateAfter: "08:00" })) },
    biometricEnrollment: { findMany: jest.fn(async () => [{ deviceUserId: "E7", userId: "staff-1" }]) },
    staffAttendanceEvent: {
      create: jest.fn(async (a: { data: { userId: string; date: Date; at: Date; kind: string } }) => {
        events.push({ userId: a.data.userId, date: a.data.date.toISOString().slice(0, 10), at: a.data.at, kind: a.data.kind });
        return a.data;
      }),
      findMany: jest.fn(async (a: { where: { userId: string; date: Date } }) =>
        events
          .filter((e) => e.userId === a.where.userId && e.date === a.where.date.toISOString().slice(0, 10))
          .sort((x, y) => x.at.getTime() - y.at.getTime())
          .map((e) => ({ at: e.at })),
      ),
    },
    staffAttendance: {
      findFirst: jest.fn(async () => day.row),
      create: jest.fn(async (a: { data: { clockInAt: Date; clockOutAt: Date | null; status: string } }) => {
        day.row = { id: "row-1", clockInAt: a.data.clockInAt, clockOutAt: a.data.clockOutAt, status: a.data.status };
        return day.row;
      }),
      update: jest.fn(async (a: { data: { clockInAt?: Date; clockOutAt?: Date | null } }) => {
        day.row = { ...day.row!, ...a.data };
        return day.row;
      }),
    },
    auditLog: { create: jest.fn(async () => ({})) },
  } as unknown as TenantTx;

  const db = { runAsTenant: <T>(_c: TenantContext, fn: (t: TenantTx) => Promise<T>) => fn(tx) };
  const svc = new StaffAttendanceService(
    db as never,
    { record: jest.fn() } as never,
    { inTx: async () => ({ timezone: TZ }), todayInTx: async () => new Date(), forSchool: async () => ({ timezone: TZ }) } as never,
    { createRequest: jest.fn(), submit: jest.fn() } as never,
    { onFinalized: jest.fn() } as never,
  );
  const send = (at: string) =>
    svc.ingestDeviceEvents("demo", "D1", "sig", Buffer.from("{}"), {
      timestamp: new Date().toISOString(),
      events: [{ deviceUserId: "E7", at }],
    });
  return { svc, send, day, events };
}

describe("a gate terminal reporting a whole day", () => {
  it("KEEPS the departure instead of counting it as a duplicate", async () => {
    const { send, events } = makeService();
    await send(ARRIVAL);
    const second = await send(DEPARTURE);
    // The scan that used to be discarded.
    expect(events).toHaveLength(2);
    // And it is reported as accepted, because it WAS: reporting it as "already
    // marked" is what made the device look like it was being listened to.
    expect(second.accepted).toBe(1);
    expect(second.alreadyMarked).toBe(0);
  });

  it("projects the day as first IN and last OUT", async () => {
    const { send, day } = makeService();
    await send(ARRIVAL);
    await send(LUNCH);
    await send(DEPARTURE);
    expect(day.row!.clockInAt!.toISOString()).toBe(ARRIVAL);
    expect(day.row!.clockOutAt!.toISOString()).toBe(DEPARTURE);
  });

  it("leaves the departure NULL after a single scan — not a zero-length day", async () => {
    // "We do not know when they left" and "they were here for no time" are
    // different facts, and only one of them is ever true of a person who
    // scanned in. Inferring the second is how a screen ends up printing 0h.
    const { send, day } = makeService();
    await send(ARRIVAL);
    expect(day.row!.clockInAt).not.toBeNull();
    expect(day.row!.clockOutAt).toBeNull();
  });

  it("does not let a departure change what LATENESS the arrival earned", async () => {
    // The status is a fact about when somebody arrived. Recomputing it when they
    // leave would let a long day erase a late start, or a short one invent it.
    const { send, day } = makeService();
    await send(ARRIVAL); // 08:05 Lagos, after the 08:00 threshold
    const statusAfterArrival = day.row!.status;
    await send(DEPARTURE);
    expect(day.row!.status).toBe(statusAfterArrival);
  });

  it("an out-of-order scan still yields the earliest IN and latest OUT", async () => {
    // Terminals batch and retry, so events do not always arrive in time order.
    // The projection reads the LOG, not the row it is updating, so the answer
    // does not depend on delivery order.
    const { send, day } = makeService();
    await send(DEPARTURE);
    await send(ARRIVAL);
    expect(day.row!.clockInAt!.toISOString()).toBe(ARRIVAL);
    expect(day.row!.clockOutAt!.toISOString()).toBe(DEPARTURE);
  });
});
