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
});
