/**
 * A boarding notice that is taken back must be taken back OUT LOUD.
 *
 * Recording a PICKUP emails the guardians "Your child has boarded the school bus
 * for pickup." A driver then scans the wrong child, or a child steps back off
 * before the bus leaves, and the record is corrected to ABSENT — and nothing
 * told the family. Measured live on the running stack:
 *
 *     transport_boarding : status ABSENT     (the child is NOT on the bus)
 *     the parent's inbox : "Your child has boarded the school bus for pickup."
 *
 * The school's own record and the family's last word disagreed about where a
 * child was. Same class as the withdrawn duties this codebase already fixed —
 * a notice given is a notice retracted — with a child's whereabouts as the
 * subject rather than a teacher's free period.
 */
import { TransportService } from "../../src/transport/transport.service";

type Boarding = { status: string } | null;

function makeService(prior: Boarding, opts: { passengerType?: string } = {}) {
  const notifications = { enqueue: jest.fn().mockResolvedValue(undefined) };
  const upserted: Array<Record<string, unknown>> = [];
  const tx = {
    // The route-scope check runs first; a school_admin is module-wide, so the
    // vehicle does not matter, but the lookup must exist as it does on a real tx.
    transportRoute: { findFirst: jest.fn().mockResolvedValue({ id: "r-1", vehicleId: "v-1" }) },
    transportAssignment: {
      findFirst: jest
        .fn()
        .mockResolvedValue({ id: "ta-1", passengerType: opts.passengerType ?? "STUDENT" }),
    },
    transportBoarding: {
      findFirst: jest.fn().mockResolvedValue(prior),
      upsert: jest.fn().mockImplementation((a: Record<string, unknown>) => {
        upserted.push(a);
        return { id: "tb-1" };
      }),
      findFirstOrThrow: jest.fn().mockResolvedValue({
        id: "tb-1", tripId: null, routeId: "r-1", passengerId: "stu-1",
        date: new Date("2026-08-27"), direction: "PICKUP", status: "ABSENT",
        method: "MANUAL", recordedById: "staff-1", recordedAt: new Date(),
      }),
    },
    user: { findMany: jest.fn().mockResolvedValue([{ id: "stu-1", name: "Ada" }]) },
    parentChild: { findMany: jest.fn().mockResolvedValue([{ parentId: "mum-1" }]) },
    auditLog: { create: jest.fn().mockResolvedValue({}) },
  };
  const db = { runAsTenant: (_c: unknown, fn: (t: unknown) => unknown) => fn(tx) };
  const audit = { record: jest.fn().mockResolvedValue(undefined) };
  const region = { inTx: jest.fn().mockResolvedValue({ timezone: "Africa/Lagos" }) };
  const svc = new TransportService(
    db as never,
    audit as never,
    notifications as never,
    {} as never, // workflow — not reached by the boarding path
    { onFinalized: () => undefined } as never, // hooks: registered in the constructor
    region as never,
  );
  return { svc, notifications };
}

const P = { schoolId: "sch-1", userId: "staff-1", permissions: [], roles: ["school_admin"] } as never;
const record = (svc: TransportService, status: string, direction = "PICKUP") =>
  svc.recordBoarding(P, {
    routeId: "r-1", passengerId: "stu-1", direction,
    method: "MANUAL", status,
  } as never);

const titles = (n: { enqueue: jest.Mock }) => n.enqueue.mock.calls.map((c) => c[1].title as string);

describe("a boarding taken back in silence", () => {
  it("tells the family when a recorded boarding is corrected to absent", async () => {
    const { svc, notifications } = makeService({ status: "BOARDED" });
    await record(svc, "ABSENT");
    expect(titles(notifications)).toEqual(["Correction: your child did not board the bus"]);
  });

  it("says plainly that the child is NOT on the bus, and what to do", async () => {
    // The message has to stand on its own: a family reading it may not have the
    // earlier one to hand.
    const { svc, notifications } = makeService({ status: "BOARDED" });
    await record(svc, "ABSENT");
    const body = notifications.enqueue.mock.calls[0][1].body as string;
    expect(body).toMatch(/NOT on the bus/);
    expect(body).toMatch(/contact the school office/i);
  });

  it("retracts nothing when no boarding was ever recorded", async () => {
    // Marking a child ABSENT outright sent no notice, so there is nothing to
    // correct — a retraction would be the first the family heard of any of it.
    const { svc, notifications } = makeService(null);
    await record(svc, "ABSENT");
    expect(notifications.enqueue).not.toHaveBeenCalled();
  });

  it("retracts nothing when the child was already absent", async () => {
    const { svc, notifications } = makeService({ status: "ABSENT" });
    await record(svc, "ABSENT");
    expect(notifications.enqueue).not.toHaveBeenCalled();
  });

  it("retracts nothing on a DROPOFF, because nothing was sent for one", async () => {
    // Only a PICKUP alerts the family — a correction for a notice that never
    // went out would be the first they heard of any of it. The send and the
    // retraction must share one condition, not two that can drift.
    const { svc, notifications } = makeService({ status: "BOARDED" });
    await record(svc, "ABSENT", "DROPOFF");
    expect(notifications.enqueue).not.toHaveBeenCalled();
  });

  it("retracts nothing for a STAFF passenger, for the same reason", async () => {
    const { svc, notifications } = makeService({ status: "BOARDED" }, { passengerType: "STAFF" });
    await record(svc, "ABSENT");
    expect(notifications.enqueue).not.toHaveBeenCalled();
  });

  it("still alerts on a fresh boarding, and not on a re-scan", async () => {
    // Magnitude: every assertion above passes against a service that notifies
    // nobody about anything.
    const fresh = makeService(null);
    await record(fresh.svc, "BOARDED");
    expect(titles(fresh.notifications)).toEqual(["Your child boarded the bus"]);

    const rescan = makeService({ status: "BOARDED" });
    await record(rescan.svc, "BOARDED");
    expect(rescan.notifications.enqueue).not.toHaveBeenCalled();
  });
});
