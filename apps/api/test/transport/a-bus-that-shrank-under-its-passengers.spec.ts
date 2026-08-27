/**
 * A bus cannot shrink below the children already on it.
 *
 * Assigning a passenger counts the seats and row-locks the route, because these
 * are physical seats on a bus. Nothing checked the OTHER side of that
 * comparison: the vehicle's own capacity could be edited afterwards, so the
 * guard was bypassed by moving the number it compares against.
 *
 * Measured live: a 40-seat bus carrying 5 passengers, set to capacity 2,
 * returned HTTP 200.
 *
 * Two hypotheses were REFUTED by the same probe and are recorded so they are not
 * re-investigated: a negative capacity is already rejected at the boundary
 * schema (400), and a route's vehicle is only settable at CREATE — when the
 * route has no passengers — so there is no swap-onto-a-smaller-bus path.
 */
import { BadRequestException } from "@nestjs/common";
import { TransportService } from "../../src/transport/transport.service";

function makeService(routes: Array<{ id: string; name: string; used: number }>) {
  const counts = new Map(routes.map((r) => [r.id, r.used]));
  const update = jest.fn().mockResolvedValue({
    id: "veh-1", name: "Bus", regNumber: null, capacity: 2,
    driverId: null, customFields: {}, createdAt: new Date(),
  });
  const tx = {
    vehicle: { findFirst: jest.fn().mockResolvedValue({ id: "veh-1", name: "Bus" }), update },
    transportRoute: { findMany: jest.fn().mockResolvedValue(routes.map((r) => ({ id: r.id, name: r.name }))) },
    transportAssignment: {
      count: jest.fn().mockImplementation((a: { where: { routeId: string } }) => counts.get(a.where.routeId) ?? 0),
    },
  };
  const svc = Object.create(TransportService.prototype) as TransportService;
  Object.assign(svc as unknown as Record<string, unknown>, {
    db: { runAsTenant: (_c: unknown, fn: (t: unknown) => unknown) => fn(tx) },
    audit: { record: jest.fn().mockResolvedValue(undefined) },
    log: jest.fn().mockResolvedValue(undefined),
    ctx: () => ({ schoolId: "sch-1", userId: "staff-1" }),
  });
  return { svc, update };
}

const P = { schoolId: "sch-1", userId: "staff-1" } as never;
const setCapacity = (svc: TransportService, capacity: number) =>
  svc.updateVehicle(P, "veh-1", { capacity });

describe("a bus that shrank under its passengers", () => {
  it("refuses to seat fewer than the passengers already assigned", async () => {
    const { svc, update } = makeService([{ id: "r-1", name: "Route 1", used: 5 }]);
    await expect(setCapacity(svc, 2)).rejects.toBeInstanceOf(BadRequestException);
    expect(update).not.toHaveBeenCalled();
  });

  it("names the route, both numbers and the way out", async () => {
    const { svc } = makeService([{ id: "r-1", name: "Route 1", used: 5 }]);
    await expect(setCapacity(svc, 2)).rejects.toThrow(/Route 1 has 5 passenger\(s\)/);
    await expect(setCapacity(svc, 2)).rejects.toThrow(/cannot be set to 2 seat\(s\)/);
    await expect(setCapacity(svc, 2)).rejects.toThrow(/Move or remove passengers first/);
  });

  it("allows a capacity that exactly fits", async () => {
    const { svc, update } = makeService([{ id: "r-1", name: "Route 1", used: 5 }]);
    await setCapacity(svc, 5);
    expect(update).toHaveBeenCalled();
  });

  it("compares against the BIGGEST route, not the total", async () => {
    // A vehicle can serve a morning and an afternoon route; the assignment check
    // is per-route for exactly that reason. Summing them would refuse a bus that
    // is perfectly able to run both.
    const { svc, update } = makeService([
      { id: "r-1", name: "Morning", used: 20 },
      { id: "r-2", name: "Afternoon", used: 18 },
    ]);
    await setCapacity(svc, 20);
    expect(update).toHaveBeenCalled();
  });

  it("still treats zero as no limit", async () => {
    // The column default, and what the assignment check already treats as unset:
    // a school that has never entered capacities must not be broken by this.
    const { svc, update } = makeService([{ id: "r-1", name: "Route 1", used: 5 }]);
    await setCapacity(svc, 0);
    expect(update).toHaveBeenCalled();
  });

  it("does not go looking when capacity is not being changed", async () => {
    // Magnitude/cost: renaming a bus must not count every passenger on it.
    const { svc, update } = makeService([{ id: "r-1", name: "Route 1", used: 5 }]);
    await svc.updateVehicle(P, "veh-1", { name: "Renamed" });
    expect(update).toHaveBeenCalled();
  });
});
