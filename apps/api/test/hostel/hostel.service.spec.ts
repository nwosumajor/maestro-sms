// =============================================================================
// HostelService — allocation/availability/fee unit tests
// =============================================================================
// Proves the capacity guardrail (no over-allocation), the single-active-bed rule,
// and that scheduling hostel fees raises invoice line items reusing a student's
// DRAFT invoice (so hostel rent collects alongside academic fees).

import { BadRequestException } from "@nestjs/common";
import { HostelService } from "../../src/hostel/hostel.service";
import type { Principal, TenantContext, TenantTx } from "../../src/integrity/integrity.foundation";

const staff: Principal = { schoolId: "A", userId: "admin", roles: ["school_admin"], permissions: ["hostel.manage"] };

function makeTx(over: Partial<Record<string, unknown>> = {}) {
  const calls = { invoiceCreate: 0, lineCreate: 0, invoiceUpdate: 0, allocationCreate: 0 };
  const tx = {
    hostel: { findFirst: jest.fn().mockResolvedValue({ id: "h1" }), findFirstOrThrow: jest.fn().mockResolvedValue({ id: "h1", name: "Hostel A", type: "MIXED", wardenId: null, customFields: {}, createdAt: new Date() }) },
    hostelRoom: {
      findFirst: jest.fn().mockResolvedValue(over.room ?? { id: "r1", hostelId: "h1", roomNumber: "R1", roomType: "SHARED", capacity: 2, rentMinor: 50000, customFields: {} }),
      findFirstOrThrow: jest.fn().mockResolvedValue({ id: "r1", hostelId: "h1", roomNumber: "R1", roomType: "SHARED", capacity: 2, rentMinor: 50000, customFields: {} }),
      findMany: jest.fn().mockResolvedValue(over.rooms ?? [{ id: "r1", rentMinor: 50000 }]),
    },
    hostelAllocation: {
      count: jest.fn().mockResolvedValue(over.occupied ?? 0),
      findFirst: jest.fn().mockResolvedValue(over.studentActive ?? null),
      create: jest.fn(() => { calls.allocationCreate++; return Promise.resolve({ id: "a1" }); }),
      findFirstOrThrow: jest.fn().mockResolvedValue({ id: "a1", roomId: "r1", studentId: "stu1", status: "ACTIVE", allocatedAt: new Date(), vacatedAt: null }),
      findMany: jest.fn().mockResolvedValue(over.allocs ?? [{ id: "a1", roomId: "r1", studentId: "stu1" }]),
    },
    invoice: {
      findFirst: jest.fn().mockResolvedValue(over.draftInvoice ?? null),
      create: jest.fn(() => { calls.invoiceCreate++; return Promise.resolve({ id: "inv1" }); }),
      update: jest.fn(() => { calls.invoiceUpdate++; return Promise.resolve({}); }),
    },
    invoiceLineItem: { create: jest.fn(() => { calls.lineCreate++; return Promise.resolve({}); }) },
    user: { findFirst: jest.fn().mockResolvedValue({ id: "stu1", name: "Stu" }) },
    // Row-lock the room for allocation concurrency (no-op in the mock).
    $executeRaw: jest.fn().mockResolvedValue(0),
  } as unknown as TenantTx;
  return { tx, calls };
}

function svc(tx: TenantTx) {
  const db = { runAsTenant: <T>(_c: TenantContext, fn: (t: TenantTx) => Promise<T>) => fn(tx) };
  const audit = { record: jest.fn().mockResolvedValue(undefined) };
  return new HostelService(db as never, audit as never);
}

describe("HostelService", () => {
  it("refuses to allocate into a full room", async () => {
    const { tx } = makeTx({ occupied: 2 }); // capacity 2, already full
    await expect(svc(tx).allocate(staff, "r1", "stu1")).rejects.toBeInstanceOf(BadRequestException);
  });

  it("refuses a second active allocation for the same student", async () => {
    const { tx } = makeTx({ occupied: 0, studentActive: { id: "existing" } });
    await expect(svc(tx).allocate(staff, "r1", "stu1")).rejects.toThrow(/already has an active/i);
  });

  it("allocates when there is room and the student is free", async () => {
    const { tx, calls } = makeTx({ occupied: 0, studentActive: null });
    const dto = await svc(tx).allocate(staff, "r1", "stu1");
    expect(dto.id).toBe("a1");
    expect(calls.allocationCreate).toBe(1);
  });

  it("scheduling fees opens an invoice + line item for an allocated student", async () => {
    const { tx, calls } = makeTx({ allocs: [{ id: "a1", roomId: "r1", studentId: "stu1" }], draftInvoice: null });
    const run = await svc(tx).scheduleFees(staff, { dueDate: "2026-09-01" });
    expect(run.studentsBilled).toBe(1);
    expect(run.totalBilledMinor).toBe(50000);
    expect(calls.invoiceCreate).toBe(1);
    expect(calls.lineCreate).toBe(1);
  });

  it("scheduling fees REUSES a student's existing DRAFT invoice (collect alongside academic fees)", async () => {
    const { tx, calls } = makeTx({ allocs: [{ id: "a1", roomId: "r1", studentId: "stu1" }], draftInvoice: { id: "inv-existing" } });
    await svc(tx).scheduleFees(staff, { dueDate: "2026-09-01" });
    expect(calls.invoiceCreate).toBe(0); // reused, not created
    expect(calls.lineCreate).toBe(1); // line still added
  });
});
