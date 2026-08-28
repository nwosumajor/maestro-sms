/**
 * A boarding roll call reported how many rows it wrote and nothing else.
 *
 * `rollCall` filters the submitted records down to CURRENT boarders, then
 * replaces the whole night's sheet. Two silences, both measured live on a house
 * of 8 with 5 boarders submitted plus one name who no longer boards there:
 *
 *   response          {"marked":5}
 *   sheet afterwards  5 rows, for a house of 8
 *
 * Three children in that house had no row at all — not present, not absent, not
 * mentioned — and the stray name was dropped without a word.
 *
 * The exam-day board already draws this distinction and says why: "we have not
 * taken the register" and "they did not come" are different problems with
 * different fixes. A boarding house is the sharper case, because the missing row
 * is a child nobody has looked for.
 */
import { HostelService } from "../../src/hostel/hostel.service";

const HOSTEL = "h-1";
const BOARDERS = ["stu-a", "stu-b", "stu-c"];

function makeService() {
  const createMany = jest.fn().mockResolvedValue({ count: 0 });
  const tx = {
    hostelRoom: { findMany: jest.fn().mockResolvedValue([{ id: "room-1" }]) },
    hostelAllocation: {
      findMany: jest.fn().mockResolvedValue(BOARDERS.map((studentId) => ({ studentId }))),
    },
    hostelAttendance: { deleteMany: jest.fn().mockResolvedValue({ count: 0 }), createMany },
  };
  const svc = Object.create(HostelService.prototype) as HostelService;
  Object.assign(svc as unknown as Record<string, unknown>, {
    db: { runAsTenant: (_c: unknown, fn: (t: unknown) => unknown) => fn(tx) },
    ctx: () => ({ schoolId: "sch-1", userId: "warden-1" }),
    assertHostelInScope: jest.fn().mockResolvedValue(undefined),
    log: jest.fn().mockResolvedValue(undefined),
  });
  return { svc, createMany };
}

const P = { schoolId: "sch-1", userId: "warden-1" } as never;
const roll = (svc: HostelService, records: Array<{ studentId: string; status: string }>) =>
  (svc as unknown as {
    rollCall: (p: unknown, h: string, d: string, r: unknown) => Promise<{ marked: number; unmarked: number; skipped: number }>;
  }).rollCall(P, HOSTEL, "2026-08-28", records);

describe("a roll call that named nobody missing", () => {
  it("counts the boarders left with no row at all", async () => {
    const { svc } = makeService();
    const res = await roll(svc, [{ studentId: "stu-a", status: "PRESENT" }]);
    expect(res.marked).toBe(1);
    expect(res.unmarked).toBe(2); // stu-b and stu-c are in the house and unaccounted for
  });

  it("counts a submitted name that no longer boards here", async () => {
    // Silently dropped before, so a warden who ticked them saw a sheet without
    // them and no reason why.
    const { svc } = makeService();
    const res = await roll(svc, [
      { studentId: "stu-a", status: "PRESENT" },
      { studentId: "stranger", status: "PRESENT" },
    ]);
    expect(res.marked).toBe(1);
    expect(res.skipped).toBe(1);
  });

  it("reports nobody missing when the whole house is marked", async () => {
    // Magnitude: the cases above would pass against a service that always
    // claimed somebody was unaccounted for.
    const { svc } = makeService();
    const res = await roll(svc, BOARDERS.map((studentId) => ({ studentId, status: "PRESENT" })));
    expect(res).toEqual({ marked: 3, unmarked: 0, skipped: 0 });
  });

  it("still writes only current boarders", async () => {
    // The filter itself is right and must survive: a stranger must not get a
    // row in this house's roll call.
    const { svc, createMany } = makeService();
    await roll(svc, [
      { studentId: "stu-a", status: "PRESENT" },
      { studentId: "stranger", status: "PRESENT" },
    ]);
    const written = createMany.mock.calls[0][0].data as Array<{ studentId: string }>;
    expect(written.map((w) => w.studentId)).toEqual(["stu-a"]);
  });
});
