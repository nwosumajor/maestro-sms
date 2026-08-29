/**
 * A fee run that bills nobody, for a route carrying thirty children.
 *
 * `fareFor` returns 0 for a STOP-mode route when the rider has no stop, and both
 * `postFeeRun` and the approver's preview did `if (fare <= 0) continue` — no
 * count, no mention. So the preview read "No fare-paying passengers in scope —
 * this run would bill nobody", which is what an EMPTY route says too.
 *
 * It is not hypothetical for a school on per-stop fares: the API can create
 * stops (`POST /transport/routes/:id/stops`), set `fareMode`, and validate that a
 * `stopId` belongs to its route — and the WEB has none of it. There is no stop
 * picker on the assignment screen, no fare-mode control, no stops screen at all
 * (`grep stopId apps/web` -> nothing). So every rider assigned through the
 * product carries `stopId: null`, and on a STOP route every one of them prices
 * at zero.
 *
 * Measured on the demo tenant: 6 routes, all FLAT; 0 stops; 30 assignments, 0
 * with a stop. LATENT — no school here is on per-stop fares — and it would go
 * wrong silently the first time one was, which is the worst moment to find out,
 * because the evidence is an invoice nobody raised.
 *
 * Building the missing screens is a feature and is deliberately not done here.
 * What is fixed is the silence.
 */
import { TransportService } from "../../src/transport/transport.service";
import type { TenantTx } from "../../src/integrity/integrity.foundation";

type Assignment = { routeId: string; stopId: string | null; passengerId: string; passengerType: string };

function make(route: { fareMode: string; flatFareMinor: number }, assignments: Assignment[]) {
  const tx = {
    transportRoute: { findFirst: jest.fn(async () => route) },
    routeStop: { findFirst: jest.fn(async () => null) },
    transportAssignment: { findMany: jest.fn(async () => assignments) },
    school: { findFirst: jest.fn(async () => ({ currency: "NGN" })) },
  } as unknown as TenantTx;
  const svc = Object.create(TransportService.prototype) as TransportService;
  Object.assign(svc as unknown as Record<string, unknown>, {
    db: { runAsTenantReadOnly: (_c: unknown, fn: (t: TenantTx) => unknown) => fn(tx) },
    ctx: () => ({ schoolId: "S", userId: "u" }),
  });
  return { svc, tx };
}

const P = { schoolId: "S", userId: "u", roles: ["school_admin"], permissions: [] } as never;
const preview = (svc: TransportService) =>
  (svc as unknown as { previewFeeRun: (p: unknown, routeId?: string) => Promise<string> })
    .previewFeeRun(P);

const riders = (n: number, stopId: string | null = null): Assignment[] =>
  Array.from({ length: n }, (_, i) => ({ routeId: "r1", stopId, passengerId: `s${i}`, passengerType: "STUDENT" }));

describe("a rider nobody priced", () => {
  it("says how many riders are not billed, instead of only that nobody is", async () => {
    const { svc } = make({ fareMode: "STOP", flatFareMinor: 0 }, riders(30));
    const s = await preview(svc);
    expect(s).toMatch(/30 riders are NOT billed/);
    expect(s).toMatch(/per-stop route with no stop set/);
  });

  it("names both causes, because a zero FLAT fare is the other one", async () => {
    const { svc } = make({ fareMode: "FLAT", flatFareMinor: 0 }, riders(4));
    expect(await preview(svc)).toMatch(/zero flat fare/);
  });

  it("still says plainly that nobody would be billed", async () => {
    // The count is an ADDITION. The outcome sentence was already right and a
    // reader needs both halves.
    const { svc } = make({ fareMode: "STOP", flatFareMinor: 0 }, riders(30));
    expect(await preview(svc)).toMatch(/would bill nobody/);
  });

  it("mentions nothing when every rider is priced", async () => {
    // A note that appears on every ordinary run is one people stop reading.
    const { svc } = make({ fareMode: "FLAT", flatFareMinor: 80000 }, riders(3));
    const s = await preview(svc);
    expect(s).toMatch(/Bills 3 passengers/);
    expect(s).not.toMatch(/NOT billed/);
  });

  it("counts a partly-priced run on both sides", async () => {
    const { svc } = make({ fareMode: "STOP", flatFareMinor: 0 }, [
      ...riders(2, "stop-1"),
      ...riders(5),
    ]);
    // routeStop.findFirst returns null here, so even the stopped riders price at
    // zero — the point is the arithmetic reports every rider it passed over.
    expect(await preview(svc)).toMatch(/7 riders are NOT billed/);
  });

  it("does not count STAFF riders, who are never invoiced", async () => {
    const { svc } = make({ fareMode: "STOP", flatFareMinor: 0 }, [
      { routeId: "r1", stopId: null, passengerId: "staff-1", passengerType: "STAFF" },
      ...riders(1),
    ]);
    expect(await preview(svc)).toMatch(/1 rider is NOT billed/);
  });
});
