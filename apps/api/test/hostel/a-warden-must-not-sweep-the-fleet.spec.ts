// =============================================================================
// A per-school permission ran a platform-wide sweep
// =============================================================================
// `POST /hostels/exeats/overdue/run` is gated on `hostel.manage` — a per-school
// permission a warden or a registrar holds — and it called the FLEET sweep.
//
// Measured across 500 boarding schools: one school's registrar pressed it and
// the run reported `scanned: 1500, alerted: 1500`. It stamped
// `overdueNotifiedAt` on 499 other schools' exeats, sent their guardians'
// alerts, and held the request open for 12.6 seconds. The job catalogue
// declared that route `scope: "SCHOOL"`, which it was not.
//
// Its siblings already knew: the dunning and reconciliation sweeps gate their
// manual triggers on platform-level permissions. This one scopes to the
// caller's school instead, which is what the permission and the declared scope
// both say. The hourly scheduler still sweeps the fleet.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ExeatOverdueService } from "../../src/hostel/exeat-overdue.service";
import { stripComments } from "../support/strip-comments";

function makeService(rows: Array<{ id: string; schoolId: string }>) {
  const findMany = jest.fn().mockResolvedValue(rows);
  const db = { client: { hostelExeat: { findMany }, school: { findMany: jest.fn().mockResolvedValue([]) } } };
  const svc = new ExeatOverdueService(db as never, {} as never);
  return { svc, findMany };
}

describe("the overdue sweep can be confined to one school", () => {
  it("filters by school when given one", async () => {
    const { svc, findMany } = makeService([]);
    await svc.sweep(new Date(), "school-1");
    expect(findMany.mock.calls[0][0].where).toMatchObject({ schoolId: "school-1" });
  });

  it("sweeps the whole fleet when not", async () => {
    // The scheduler's call. A `schoolId: undefined` in the where clause would
    // match nothing in Prisma, so its ABSENCE is the property.
    const { svc, findMany } = makeService([]);
    await svc.sweep(new Date());
    expect(findMany.mock.calls[0][0].where).not.toHaveProperty("schoolId");
  });
});

describe("the manual route is the caller's school, not the platform's", () => {
  const controller = stripComments(
    readFileSync(join(__dirname, "../../src/hostel/hostel.controller.ts"), "utf8"),
  );

  it("found the source it is about", () => {
    expect(controller.length).toBeGreaterThan(3000);
  });

  it("passes the caller's school into the sweep", () => {
    const at = controller.indexOf('@Post("exeats/overdue/run")');
    expect(at).toBeGreaterThan(-1);
    const body = controller.slice(at, at + 600);
    expect(body).toMatch(/this\.overdue\.sweep\(new Date\(\), p\.schoolId\)/);
  });

  it("still declares the per-school permission it is gated on", () => {
    // If this ever becomes a platform action it must move to a platform
    // permission, the way the dunning and reconciliation triggers did — not
    // stay on hostel.manage.
    const at = controller.indexOf('@Post("exeats/overdue/run")');
    expect(controller.slice(at, at + 200)).toMatch(/HOSTEL_PERMISSIONS\.HOSTEL_MANAGE/);
  });
});
