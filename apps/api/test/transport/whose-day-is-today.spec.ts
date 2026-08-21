// =============================================================================
// The bus register filed against the server's day, not the school's
// =============================================================================
// CLAUDE.md states the rule and lists who follows it: "today" is the SCHOOL's
// calendar day — the class register, the gate-scan check-in, the term lock, the
// seven-day stale rule, the exam-release gate, the staff clock-in, the
// installment overdue state and the receivables ageing all use `schoolToday`.
// Deciding in UTC filed a Singapore morning register against Sunday and a
// Toronto evening one against Tuesday.
//
// Two places still asked the server:
//
//   the BUS REGISTER, which is keyed on (passenger, date, direction). A school
//   east of UTC records its morning pickup before UTC midnight — 07:30 in
//   Singapore is 23:30 the PREVIOUS day — so the run was filed against
//   yesterday, upserting on top of yesterday's row for the same child and
//   direction. One journey overwrites another, and the register for the day a
//   parent asks about is the wrong one.
//
//   the EXAM-DAY BOARD's default date, so a school east of UTC opening it on an
//   exam morning saw yesterday's halls and sittings.
//
// A boarding is a safeguarding record: it is the answer to "was my child on the
// bus". Being a day out is not a display problem.
// =============================================================================

import { TransportService } from "../../src/transport/transport.service";
import { schoolToday } from "@sms/types";
import type { Principal, TenantContext, TenantTx } from "../../src/integrity/integrity.foundation";

/** 23:30 UTC — already tomorrow in Singapore, still today in Lagos and Toronto. */
const LATE_UTC = new Date("2026-08-20T23:30:00.000Z");

function makeService(timezone: string, now: Date) {
  const upsert = jest.fn(
    (args: { create: Record<string, unknown>; where: { passengerId_date_direction: { date: Date } } }) =>
      Promise.resolve({ id: "b-1", ...args.create }),
  );
  const tx = {
    transportRoute: { findFirst: jest.fn().mockResolvedValue({ id: "r-1", schoolId: "A" }) },
    transportAssignment: { findFirst: jest.fn().mockResolvedValue({ id: "a-1", passengerType: "STUDENT" }) },
    transportBoarding: { findFirst: jest.fn().mockResolvedValue(null), upsert },
    parentChild: { findMany: jest.fn().mockResolvedValue([]) },
  } as unknown as TenantTx;
  const svc = Object.create(TransportService.prototype) as TransportService;
  Object.assign(svc, {
    db: { runAsTenant: <T>(_c: TenantContext, fn: (t: TenantTx) => Promise<T>) => fn(tx) },
    audit: { record: jest.fn() },
    notifications: { enqueue: jest.fn() },
    region: { inTx: jest.fn().mockResolvedValue({ timezone }) },
    logger: { log: jest.fn(), warn: jest.fn(), error: jest.fn() },
  });
  // The service's own helpers, stubbed to keep this about the DATE.
  (svc as unknown as { assertRouteInScope: unknown }).assertRouteInScope = jest.fn().mockResolvedValue(undefined);
  (svc as unknown as { boardingDto: unknown }).boardingDto = jest.fn().mockResolvedValue({ id: "b-1" });
  (svc as unknown as { log: unknown }).log = jest.fn().mockResolvedValue(undefined);
  (svc as unknown as { notifyGuardians: unknown }).notifyGuardians = jest.fn().mockResolvedValue(undefined);
  jest.useFakeTimers().setSystemTime(now);
  return { svc, upsert };
}

afterEach(() => jest.useRealTimers());

const driver: Principal = { schoolId: "A", userId: "d-1", roles: ["driver"], permissions: ["transport.manage"] };
const board = (svc: TransportService) =>
  svc.recordBoarding(driver, { routeId: "r-1", passengerId: "kid-1", direction: "PICKUP" });

describe("which day a boarding is filed against", () => {
  it("uses the SCHOOL's day, not the server's", async () => {
    // 23:30 UTC on the 20th is 07:30 on the 21st in Singapore. The child is
    // boarding the morning bus, and the register must say the 21st.
    const { svc, upsert } = makeService("Asia/Singapore", LATE_UTC);
    await board(svc);
    expect(upsert.mock.calls[0][0].create.date).toEqual(new Date("2026-08-21T00:00:00.000Z"));
  });

  it("still says the 20th for a school west of UTC at the same instant", async () => {
    // Toronto is on the 20th at 19:30. Same moment, different day, and both
    // registers are right.
    const { svc, upsert } = makeService("America/Toronto", LATE_UTC);
    await board(svc);
    expect(upsert.mock.calls[0][0].create.date).toEqual(new Date("2026-08-20T00:00:00.000Z"));
  });

  it("keys the upsert on that same day", async () => {
    // The unique key is (passenger, date, direction). A wrong day does not
    // merely mislabel the row — it collides with another day's journey.
    const { svc, upsert } = makeService("Asia/Singapore", LATE_UTC);
    await board(svc);
    expect(upsert.mock.calls[0][0].where.passengerId_date_direction.date).toEqual(new Date("2026-08-21T00:00:00.000Z"));
  });

  it("honours an explicit date and asks the region nothing", async () => {
    // Recording yesterday's run by hand must not be silently moved.
    const { svc, upsert } = makeService("Asia/Singapore", LATE_UTC);
    await svc.recordBoarding(driver, { routeId: "r-1", passengerId: "kid-1", date: "2026-08-14" });
    expect(upsert.mock.calls[0][0].create.date).toEqual(new Date("2026-08-14T00:00:00.000Z"));
  });

  it("agrees with the helper every other register uses", async () => {
    // Not a re-implementation: the same function the class register, the gate
    // scan and the staff clock-in call.
    const { svc, upsert } = makeService("Pacific/Auckland", LATE_UTC);
    await board(svc);
    expect(upsert.mock.calls[0][0].create.date).toEqual(schoolToday("Pacific/Auckland", LATE_UTC));
  });
});
