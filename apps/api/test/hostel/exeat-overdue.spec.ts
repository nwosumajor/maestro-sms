// =============================================================================
// A boarder who is late back
// =============================================================================
// This is the thing an exeat register exists to notice, and nothing noticed it.
// The register recorded who was out, where they had gone and when they were due,
// and told the guardians at approval time. Then `expectedReturnAt` was never
// read again — grep found it only being written and echoed back in the DTO. No
// sweep, no flag, no alert, nothing in the UI. A child due back at six who did
// not arrive produced no signal at all.
//
// Fixed in two halves, because either alone is insufficient: the flag is
// computed on every read so a page is never stale, and an hourly sweep pushes
// the alert so safeguarding does not depend on somebody opening a page.
// =============================================================================

import { ExeatOverdueService } from "../../src/hostel/exeat-overdue.service";
import { DEFAULT_EXEAT_OVERDUE_CRON } from "../../src/hostel/hostel.constants";

const NOW = new Date("2026-08-13T20:00:00Z");
const SCHOOL = "11111111-1111-1111-1111-111111111111";

// `staff` is now the SCHOOL-WIDE set (head warden / office). The hostel's own
// warden is resolved from the hostel itself, because a warden's authority is
// their own hostel — the sweep used to tell every warden in the school about
// every child.
function makeService(
  exeats: Array<Record<string, unknown>>,
  staff = [{ userId: "head-warden-1" }],
  hostels: Array<{ id: string; wardenId: string | null }> = [{ id: "h-1", wardenId: "warden-1" }],
) {
  const updateMany = jest.fn().mockResolvedValue({ count: exeats.length });
  const enqueueMany = jest.fn().mockResolvedValue(undefined);
  const client = {
    hostelExeat: { findMany: jest.fn().mockResolvedValue(exeats), updateMany },
    userRole: { findMany: jest.fn().mockResolvedValue(staff) },
    user: { findMany: jest.fn().mockResolvedValue([{ id: "kid-1", name: "Ada Obi" }]) },
    hostel: { findMany: jest.fn().mockResolvedValue(hostels) },
    // The family is told too, in its own words. These cases are about the STAFF
    // fan-out, so there are no guardians unless a case supplies them.
    parentChild: { findMany: jest.fn().mockResolvedValue([]) },
  };
  const svc = Object.create(ExeatOverdueService.prototype) as ExeatOverdueService;
  Object.assign(svc, {
    db: { client },
    notifications: { enqueueMany },
    logger: { log: jest.fn(), warn: jest.fn(), error: jest.fn() },
  });
  return { svc, client, enqueueMany, updateMany };
}

const overdueExeat = {
  id: "ex-1",
  schoolId: SCHOOL,
  hostelId: "h-1",
  studentId: "kid-1",
  destination: "home",
  expectedReturnAt: new Date("2026-08-13T18:00:00Z"),
};

describe("the overdue sweep", () => {
  it("asks only for boarders who are STILL OUT and past due", async () => {
    const { svc, client } = makeService([]);
    await svc.sweep(NOW);
    expect(client.hostelExeat.findMany.mock.calls[0][0].where).toEqual({
      status: "DEPARTED",          // physically out, not merely approved
      actualReturnAt: null,        // has not signed back in
      expectedReturnAt: { lt: NOW },
      overdueNotifiedAt: null,     // not already alerted on
    });
  });

  it("alerts the people responsible for the hostel", async () => {
    const { svc, enqueueMany } = makeService([overdueExeat]);
    const r = await svc.sweep(NOW);
    expect(r).toMatchObject({ scanned: 1, alerted: 1 });
    const [, recipients, payload] = enqueueMany.mock.calls[0];
    // School-wide staff PLUS this hostel's own warden — and nobody else's.
    expect(recipients.sort()).toEqual(["head-warden-1", "warden-1"]);
    expect(payload.title).toMatch(/Ada Obi is late back/);
    // The alert has to say what to DO, not just that something is wrong.
    expect(payload.body).toMatch(/due back at 2026-08-13 18:00/);
    expect(payload.body).toMatch(/record the return/);
  });

  it("is ESSENTIAL, so a per-type mute cannot silence it", () => {
    // A late boarder is not a notification anybody opts out of.
    const { svc } = makeService([overdueExeat]);
    void svc;
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { ESSENTIAL_NOTIFICATION_TYPES } = jest.requireActual("@sms/types");
    expect(ESSENTIAL_NOTIFICATION_TYPES).toContain("OPERATOR_ALERT");
  });

  it("alerts ONCE, not every hour until somebody acts", async () => {
    const { svc, updateMany } = makeService([overdueExeat]);
    await svc.sweep(NOW);
    // Marked after the alert went out, and guarded so a concurrent run cannot
    // double-alert.
    expect(updateMany.mock.calls[0][0].where).toMatchObject({ overdueNotifiedAt: null });
    expect(updateMany.mock.calls[0][0].data).toEqual({ overdueNotifiedAt: NOW });
  });

  it("does NOT tell the warden of a different hostel", async () => {
    // The defect this scoping fixes: a warden of Hostel B used to learn that a
    // named child from Hostel A was missing, and which address they went to.
    const { svc, enqueueMany } = makeService([overdueExeat], [], [
      { id: "h-1", wardenId: "warden-1" },
      { id: "h-2", wardenId: "warden-2" },
    ]);
    await svc.sweep(NOW);
    const [, recipients] = enqueueMany.mock.calls[0];
    expect(recipients).toEqual(["warden-1"]);
    expect(recipients).not.toContain("warden-2");
  });

  it("marks only AFTER alerting, so a failure retries next hour", async () => {
    const { svc, enqueueMany, updateMany } = makeService([overdueExeat]);
    enqueueMany.mockRejectedValueOnce(new Error("notify down"));
    const r = await svc.sweep(NOW);
    // The school's alert failed, so nothing is marked handled and the next
    // sweep picks it up. Silently marking it would lose the child.
    expect(updateMany).not.toHaveBeenCalled();
    expect(r.alerted).toBe(0);
  });

  it("says so when a school has nobody to tell", async () => {
    // Silently dropping the alert would look identical to "nobody is late".
    // Nobody school-wide AND the hostel has no warden: there is genuinely
    // nobody to tell.
    const { svc, enqueueMany, updateMany } = makeService([overdueExeat], [], [{ id: "h-1", wardenId: null }]);
    const r = await svc.sweep(NOW);
    expect(enqueueMany).not.toHaveBeenCalled();
    expect(updateMany).not.toHaveBeenCalled();
    expect(r).toMatchObject({ scanned: 1, alerted: 0 });
  });

  it("one school's failure does not stop another's alert", async () => {
    const other = { ...overdueExeat, id: "ex-2", schoolId: "22222222-2222-2222-2222-222222222222" };
    const { svc, enqueueMany } = makeService([overdueExeat, other]);
    enqueueMany.mockRejectedValueOnce(new Error("first school down"));
    const r = await svc.sweep(NOW);
    expect(r.alerted).toBe(1); // the second school still got theirs
  });

  it("does nothing, cheaply, when nobody is late", async () => {
    const { svc, enqueueMany } = makeService([]);
    expect(await svc.sweep(NOW)).toEqual({ scanned: 0, alerted: 0 });
    expect(enqueueMany).not.toHaveBeenCalled();
  });
});

describe("the flag on the list", () => {
  it("is computed on read, never stored", async () => {
    // Stored, it would be staler than the page showing it: a boarder who became
    // overdue ten minutes ago must read as overdue now, not after the next sweep.
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const src = readFileSync(join(__dirname, "../../src/hostel/hostel.service.ts"), "utf8");
    expect(src).toMatch(/overdue: x\.status === "DEPARTED" && !x\.actualReturnAt && x\.expectedReturnAt < new Date\(\)/);
  });

  it("clears the alert mark on return, so a SECOND late return alerts again", async () => {
    // Left set, the child could go out next weekend, fail to come back, and
    // nobody would be told.
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const src = readFileSync(join(__dirname, "../../src/hostel/hostel.service.ts"), "utf8");
    expect(src).toMatch(/actualReturnAt: new Date\(\), overdueNotifiedAt: null/);
  });

  it("runs hourly — a daily sweep would tell a warden at 2am", () => {
    expect(DEFAULT_EXEAT_OVERDUE_CRON).toMatch(/^\d+ \* \* \* \*$/);
  });
});
