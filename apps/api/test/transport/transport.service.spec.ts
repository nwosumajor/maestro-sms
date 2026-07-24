// =============================================================================
// TransportService — seat availability, fare modes, fee billing, route-change alert
// =============================================================================

import { BadRequestException } from "@nestjs/common";
import { TransportService } from "../../src/transport/transport.service";
import type { Principal, TenantContext, TenantTx } from "../../src/integrity/integrity.foundation";

const staff: Principal = { schoolId: "A", userId: "admin", roles: ["school_admin"], permissions: ["transport.manage"] };

function makeTx(over: Record<string, unknown> = {}) {
  const calls = { assignCreate: 0, invoiceCreate: 0, lineCreate: 0 };
  const tx = {
    vehicle: { findFirst: jest.fn().mockResolvedValue(over.vehicle ?? { id: "v1", capacity: 2 }) },
    transportRoute: {
      findFirst: jest.fn().mockResolvedValue(over.route ?? { id: "r1", vehicleId: "v1", status: "ACTIVE", fareMode: "FLAT", flatFareMinor: 30000, name: "Route 1" }),
      findFirstOrThrow: jest.fn().mockResolvedValue({ id: "r1", name: "Route 1", vehicleId: "v1", sessionId: null, fareMode: "FLAT", flatFareMinor: 30000, status: "ACTIVE", customFields: {}, createdAt: new Date() }),
    },
    routeStop: {
      findFirst: jest.fn().mockResolvedValue(over.stop ?? { id: "s1", fareMinor: 20000 }),
      findMany: jest.fn().mockResolvedValue([]),
    },
    transportAssignment: {
      count: jest.fn().mockResolvedValue(over.used ?? 0),
      findFirst: jest.fn().mockResolvedValue(over.passengerActive ?? null),
      create: jest.fn(() => { calls.assignCreate++; return Promise.resolve({ id: "a1" }); }),
      findFirstOrThrow: jest.fn().mockResolvedValue({ id: "a1", routeId: "r1", stopId: null, passengerId: "stu1", passengerType: "STUDENT", status: "ACTIVE" }),
      findMany: jest.fn().mockResolvedValue(over.assignments ?? [{ id: "a1", routeId: "r1", stopId: null, passengerId: "stu1", passengerType: "STUDENT" }]),
    },
    invoice: {
      findFirst: jest.fn().mockResolvedValue(over.draftInvoice ?? null),
      create: jest.fn(() => { calls.invoiceCreate++; return Promise.resolve({ id: "inv1" }); }),
      update: jest.fn().mockResolvedValue({}),
    },
    invoiceLineItem: { create: jest.fn(() => { calls.lineCreate++; return Promise.resolve({}); }) },
    user: { findFirst: jest.fn().mockResolvedValue({ id: "stu1", name: "Stu" }) },
  } as unknown as TenantTx;
  return { tx, calls };
}

function svc(tx: TenantTx) {
  const db = { runAsTenant: <T>(_c: TenantContext, fn: (t: TenantTx) => Promise<T>) => fn(tx) };
  const audit = { record: jest.fn().mockResolvedValue(undefined) };
  const notifications = { enqueue: jest.fn().mockResolvedValue(undefined) };
  const workflow = { createRequest: jest.fn().mockResolvedValue({ id: "wf1" }), submit: jest.fn().mockResolvedValue({}) };
  const hooks = { onFinalized: jest.fn() };
  return new TransportService(db as never, audit as never, notifications as never, workflow as never, hooks as never);
}

describe("TransportService", () => {
  it("refuses to assign beyond vehicle seat capacity", async () => {
    const { tx } = makeTx({ used: 2 }); // capacity 2 already used
    await expect(svc(tx).assign(staff, { routeId: "r1", passengerId: "stu1", passengerType: "STUDENT" })).rejects.toBeInstanceOf(BadRequestException);
  });

  it("refuses a second active assignment for the same passenger", async () => {
    const { tx } = makeTx({ used: 0, passengerActive: { id: "existing" } });
    await expect(svc(tx).assign(staff, { routeId: "r1", passengerId: "stu1", passengerType: "STUDENT" })).rejects.toThrow(/already has an active/i);
  });

  it("assigns within capacity", async () => {
    const { tx, calls } = makeTx({ used: 0, passengerActive: null });
    const dto = await svc(tx).assign(staff, { routeId: "r1", passengerId: "stu1", passengerType: "STUDENT" });
    expect(dto.id).toBe("a1");
    expect(calls.assignCreate).toBe(1);
  });

  it("bills the FLAT route fare as an invoice line item", async () => {
    const { tx, calls } = makeTx({ assignments: [{ id: "a1", routeId: "r1", stopId: null, passengerId: "stu1", passengerType: "STUDENT" }] });
    const run = (await svc(tx).scheduleFees(staff, { dueDate: "2026-09-01" })) as { invoicesCreated: number; totalBilledMinor: number; passengersBilled: number };
    expect(run.passengersBilled).toBe(1);
    expect(run.totalBilledMinor).toBe(30000); // flat fare
    expect(calls.lineCreate).toBe(1);
  });

  it("listAssignments batches route/stop/passenger lookups and computes fare in-memory (no N+1)", async () => {
    const rows = [
      { id: "a1", routeId: "r1", stopId: "s1", passengerId: "u1", passengerType: "STUDENT", status: "ACTIVE" },
      { id: "a2", routeId: "r2", stopId: null, passengerId: "u2", passengerType: "STUDENT", status: "ACTIVE" },
    ];
    const routeFindMany = jest.fn().mockResolvedValue([
      { id: "r1", name: "North Line", fareMode: "PER_STOP", flatFareMinor: 0 },
      { id: "r2", name: "Flat Line", fareMode: "FLAT", flatFareMinor: 7000 },
    ]);
    const stopFindMany = jest.fn().mockResolvedValue([{ id: "s1", name: "Stop A", fareMinor: 3000 }]);
    const userFindMany = jest.fn().mockResolvedValue([
      { id: "u1", name: "Ada" },
      { id: "u2", name: "Bola" },
    ]);
    const assignmentFindFirstOrThrow = jest.fn(); // must NOT be called
    const tx = {
      transportAssignment: { findMany: jest.fn().mockResolvedValue(rows), findFirstOrThrow: assignmentFindFirstOrThrow },
      transportRoute: { findMany: routeFindMany },
      routeStop: { findMany: stopFindMany },
      user: { findMany: userFindMany },
    } as unknown as TenantTx;

    const dtos = await svc(tx).listAssignments(staff);
    expect(dtos.map((d) => d.routeName)).toEqual(["North Line", "Flat Line"]);
    expect(dtos.map((d) => d.passengerName)).toEqual(["Ada", "Bola"]);
    // Fare: per-stop route uses the stop fare (3000); flat route uses its flat fare (7000).
    expect(dtos.map((d) => d.fareMinor)).toEqual([3000, 7000]);
    expect(routeFindMany).toHaveBeenCalledTimes(1);
    expect(userFindMany).toHaveBeenCalledTimes(1);
    expect(assignmentFindFirstOrThrow).not.toHaveBeenCalled();
  });

  it("recordBoarding on a PICKUP notifies the student's guardians", async () => {
    const enqueue = jest.fn().mockResolvedValue({ id: "n-1" });
    const tx = {
      transportRoute: { findFirst: jest.fn().mockResolvedValue({ id: "r1", vehicleId: "v1" }) },
      transportAssignment: { findFirst: jest.fn().mockResolvedValue({ id: "as1", passengerType: "STUDENT" }) },
      transportBoarding: {
        upsert: jest.fn().mockResolvedValue({ id: "b1" }),
        findFirstOrThrow: jest.fn().mockResolvedValue({ id: "b1", tripId: null, routeId: "r1", passengerId: "stu1", date: new Date(), direction: "PICKUP", status: "BOARDED", method: "MANUAL", recordedById: "admin", recordedAt: new Date() }),
      },
      parentChild: { findMany: jest.fn().mockResolvedValue([{ parentId: "dad-1" }]) },
      user: { findMany: jest.fn().mockResolvedValue([{ id: "stu1", name: "Ada" }]) },
    } as unknown as TenantTx;
    const db = { runAsTenant: <T>(_c: TenantContext, fn: (t: TenantTx) => Promise<T>) => fn(tx) };
    const audit = { record: jest.fn().mockResolvedValue(undefined) };
    const service = new TransportService(db as never, audit as never, { enqueue } as never, {} as never, { onFinalized: jest.fn() } as never);
    await service.recordBoarding(staff, { routeId: "r1", passengerId: "stu1", direction: "PICKUP" });
    expect(enqueue).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ recipientId: "dad-1", type: "TRANSPORT" }));
  });

  it("recordBoarding rejects a passenger not assigned to the route", async () => {
    const tx = {
      transportRoute: { findFirst: jest.fn().mockResolvedValue({ id: "r1", vehicleId: "v1" }) },
      transportAssignment: { findFirst: jest.fn().mockResolvedValue(null) }, // not assigned
    } as unknown as TenantTx;
    await expect(svc(tx).recordBoarding(staff, { routeId: "r1", passengerId: "stranger", direction: "PICKUP" })).rejects.toThrow(/not assigned/i);
  });

  it("junior_admin (transport.read) gets fleet-wide READ scope but no structural write power", async () => {
    const ja: Principal = { schoolId: "A", userId: "ja", roles: ["junior_admin"], permissions: ["transport.read"] };
    const assignFindMany = jest.fn().mockResolvedValue([]);
    const tx = {
      transportAssignment: { findMany: assignFindMany },
      transportRoute: { findMany: jest.fn() },
      routeStop: { findMany: jest.fn() },
      user: { findMany: jest.fn() },
    } as unknown as TenantTx;
    await svc(tx).listAssignments(ja);
    // Fleet-wide read: no driver/route/vehicle filter, just ACTIVE.
    const where = assignFindMany.mock.calls[0][0].where as Record<string, unknown>;
    expect(where.route).toBeUndefined();
    expect(where.status).toBe("ACTIVE");
    // ...but a structural act (wide()-only) is refused at the service.
    await expect(svc(tx).deleteVehicle(ja, "v1")).rejects.toThrow(/administrator/i);
  });
});
