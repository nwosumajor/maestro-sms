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
    // The fee runs now (a) read the SCHOOL's currency, so an invoice is not
    // raised in the column default that settlement would later refuse, and
    // (b) look for an existing charge line so a second run cannot double-bill.
    // Both are new reads these doubles have to model.
    school: { findFirst: jest.fn().mockResolvedValue({ currency: "NGN" }) },
    invoiceLineItem: {
      findMany: jest.fn().mockResolvedValue([]),
      create: jest.fn(() => { calls.lineCreate++; return Promise.resolve({}); }),
    },
    // `status` because every real `user` row has one, and assigning a place or
    // a warden duty now refuses anybody who has left the school.
    user: { findFirst: jest.fn().mockResolvedValue({ id: "stu1", name: "Stu", status: "ACTIVE" }) },
    // Row-lock the room for allocation concurrency (no-op in the mock).
    $executeRaw: jest.fn().mockResolvedValue(0),
  } as unknown as TenantTx;
  return { tx, calls };
}

function svc(tx: TenantTx) {
  const db = { runAsTenant: <T>(_c: TenantContext, fn: (t: TenantTx) => Promise<T>) => fn(tx) };
  const audit = { record: jest.fn().mockResolvedValue(undefined) };
  const workflow = { createRequest: jest.fn().mockResolvedValue({ id: "wf1" }), submit: jest.fn().mockResolvedValue({}) };
  const hooks = { onFinalized: jest.fn() };
  const notifications = { enqueue: jest.fn().mockResolvedValue({ id: "n-1" }) };
  // The region is how a notice renders an instant the way the school reads a
  // clock; a stub here keeps the fixture off the platform default.
  const region = { forSchool: jest.fn().mockResolvedValue({ timezone: "Africa/Lagos" }) };
  return new HostelService(
    db as never,
    audit as never,
    workflow as never,
    hooks as never,
    notifications as never,
    region as never,
  );
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
    // `staff` is an admin (wide) -> posts DIRECTLY; non-admins go through the
    // FEE_SCHEDULE maker-checker instead (covered by the pendingApproval case).
    const run = (await svc(tx).scheduleFees(staff, { dueDate: "2026-09-01" })) as { studentsBilled: number; totalBilledMinor: number };
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

  it("listAllocations batches room/hostel/student lookups (no per-allocation N+1)", async () => {
    const allocs = [
      { id: "a1", roomId: "r1", studentId: "u1", status: "ACTIVE", allocatedAt: new Date(), vacatedAt: null },
      { id: "a2", roomId: "r2", studentId: "u2", status: "ACTIVE", allocatedAt: new Date(), vacatedAt: null },
      { id: "a3", roomId: "r1", studentId: "u3", status: "ACTIVE", allocatedAt: new Date(), vacatedAt: null },
    ];
    const roomFindMany = jest
      .fn()
      .mockResolvedValueOnce([{ id: "r1" }, { id: "r2" }]) // roomWhere scope pass
      .mockResolvedValueOnce([
        { id: "r1", roomNumber: "101", rentMinor: 5000, hostelId: "h1" },
        { id: "r2", roomNumber: "102", rentMinor: 6000, hostelId: "h1" },
      ]);
    const hostelFindMany = jest.fn().mockResolvedValue([{ id: "h1", name: "Blue House" }]);
    const userFindMany = jest.fn().mockResolvedValue([
      { id: "u1", name: "Ada" },
      { id: "u2", name: "Bola" },
      { id: "u3", name: "Chidi" },
    ]);
    const allocFindFirstOrThrow = jest.fn(); // must NOT be called (that was the N+1)
    const tx = {
      hostelRoom: { findMany: roomFindMany },
      hostel: { findMany: hostelFindMany },
      hostelAllocation: { findMany: jest.fn().mockResolvedValue(allocs), findFirstOrThrow: allocFindFirstOrThrow },
      user: { findMany: userFindMany },
    } as unknown as TenantTx;

    const dtos = await svc(tx).listAllocations(staff);
    expect(dtos.map((d) => d.studentName)).toEqual(["Ada", "Bola", "Chidi"]);
    expect(dtos.map((d) => d.roomNumber)).toEqual(["101", "102", "101"]);
    expect(dtos.map((d) => d.hostelName)).toEqual(["Blue House", "Blue House", "Blue House"]);
    expect(dtos.map((d) => d.rentMinor)).toEqual([5000, 6000, 5000]);
    expect(hostelFindMany).toHaveBeenCalledTimes(1);
    expect(userFindMany).toHaveBeenCalledTimes(1);
    expect(allocFindFirstOrThrow).not.toHaveBeenCalled();
  });

  it("a BOYS hostel REJECTS a female student (gender match)", async () => {
    const tx = {
      hostelRoom: { findFirst: jest.fn().mockResolvedValue({ id: "r1", hostelId: "hb", capacity: 2 }) },
      hostel: { findFirst: jest.fn().mockResolvedValue({ type: "BOYS", name: "Boys House" }) },
      user: { findFirst: jest.fn().mockResolvedValue({ id: "girl", name: "Girl", status: "ACTIVE" }) },
      studentProfile: { findFirst: jest.fn().mockResolvedValue({ gender: "F" }) },
      hostelAllocation: { count: jest.fn(), findFirst: jest.fn() },
      $executeRaw: jest.fn(),
    } as unknown as TenantTx;
    await expect(svc(tx).allocate(staff, "r1", "girl")).rejects.toThrow(/boys hostel/i);
  });

  it("a BOYS hostel ADMITS a male student", async () => {
    const tx = {
      hostelRoom: { findFirst: jest.fn().mockResolvedValue({ id: "r1", hostelId: "hb", capacity: 2 }), findFirstOrThrow: jest.fn().mockResolvedValue({ id: "r1", hostelId: "hb", roomNumber: "1", rentMinor: 0 }) },
      hostel: { findFirst: jest.fn().mockResolvedValue({ type: "BOYS", name: "Boys House" }), findFirstOrThrow: jest.fn().mockResolvedValue({ name: "Boys House" }) },
      user: { findFirst: jest.fn().mockResolvedValue({ id: "boy", name: "Boy", status: "ACTIVE" }) },
      studentProfile: { findFirst: jest.fn().mockResolvedValue({ gender: "M" }) },
      hostelAllocation: { count: jest.fn().mockResolvedValue(0), findFirst: jest.fn().mockResolvedValue(null), create: jest.fn().mockResolvedValue({ id: "a1" }), findFirstOrThrow: jest.fn().mockResolvedValue({ id: "a1", roomId: "r1", studentId: "boy", status: "ACTIVE", allocatedAt: new Date(), vacatedAt: null }) },
      $executeRaw: jest.fn().mockResolvedValue(0),
    } as unknown as TenantTx;
    const dto = await svc(tx).allocate(staff, "r1", "boy");
    expect(dto.id).toBe("a1");
  });

  it("exeat is maker-checker: the requester cannot decide their own request", async () => {
    const tx = {
      hostelExeat: {
        findFirst: jest.fn().mockResolvedValue({ id: "e1", hostelId: "h1", studentId: "stu1", status: "REQUESTED", requestedById: "warden-1" }),
      },
      hostel: { findFirst: jest.fn().mockResolvedValue({ wardenId: null }) },
    } as unknown as TenantTx;
    const warden: Principal = { schoolId: "A", userId: "warden-1", roles: ["school_admin"], permissions: ["hostel.manage"] };
    await expect(svc(tx).decideExeat(warden, "e1", true)).rejects.toThrow(/different person/i);
  });

  it("junior_admin (hostel.read) gets module-wide READ scope but no structural write power", async () => {
    const ja: Principal = { schoolId: "A", userId: "ja", roles: ["junior_admin"], permissions: ["hostel.read"] };
    const roomFindMany = jest.fn().mockResolvedValueOnce([]); // scope query -> no rooms -> empty page
    const tx = {
      hostelRoom: { findMany: roomFindMany },
      hostelAllocation: { findMany: jest.fn().mockResolvedValue([]) },
      hostel: { findMany: jest.fn() },
      user: { findMany: jest.fn() },
    } as unknown as TenantTx;
    await svc(tx).listAllocations(ja);
    // Module-wide read: the room scope is {} (ALL hostels), not warden-confined.
    expect(roomFindMany).toHaveBeenCalledWith(expect.objectContaining({ where: {} }));
    // ...but a structural act (wide()-only) is refused at the service.
    await expect(svc(tx).deleteHostel(ja, "h1")).rejects.toThrow(/administrator/i);
  });

  // ===========================================================================
  // Allocation listing: bounded, and searchable by student name
  // ===========================================================================
  describe("listAllocations", () => {
    const mk = (tx: Record<string, unknown>) => {
      const db = { runAsTenant: <T>(_c: unknown, fn: (t: unknown) => Promise<T>) => fn(tx) };
      return new HostelService(
        db as never,
        { record: jest.fn() } as never,
        {} as never, // workflow (unused on this path)
        { onFinalized: jest.fn() } as never, // hooks — the ctor registers a reactor
        { enqueue: jest.fn() } as never,
        { forSchool: jest.fn().mockResolvedValue({ timezone: "Africa/Lagos" }) } as never,
      );
    };
    const wide: Principal = { schoolId: "A", userId: "adm", roles: ["school_admin"], permissions: ["hostel.read", "hostel.manage"] };

    it("bounds the query instead of shipping every occupied bed", async () => {
      const allocFindMany = jest.fn().mockResolvedValue([]);
      await mk({
        hostelRoom: { findMany: jest.fn().mockResolvedValue([{ id: "r1" }]) },
        hostelAllocation: { findMany: allocFindMany },
      }).listAllocations(wide);
      const arg = allocFindMany.mock.calls[0][0] as { take?: number };
      expect(typeof arg.take).toBe("number");
      expect(arg.take).toBeGreaterThan(0);
    });

    it("resolves a name search to student ids first (studentId has no Prisma relation)", async () => {
      const userFindMany = jest.fn().mockResolvedValue([{ id: "stu-1" }]);
      const allocFindMany = jest.fn().mockResolvedValue([]);
      await mk({
        hostelRoom: { findMany: jest.fn().mockResolvedValue([{ id: "r1" }]) },
        hostelAllocation: { findMany: allocFindMany },
        user: { findMany: userFindMany },
      }).listAllocations(wide, undefined, "ada");
      expect(userFindMany).toHaveBeenCalled();
      const where = (allocFindMany.mock.calls[0][0] as { where: { studentId?: { in: string[] } } }).where;
      expect(where.studentId).toEqual({ in: ["stu-1"] });
    });

    it("returns nothing when the name matches nobody — not everybody", async () => {
      // The failure mode worth guarding: an unmatched filter that silently falls
      // back to the full list reads as "search is broken" or, worse, goes unnoticed.
      const allocFindMany = jest.fn();
      const out = await mk({
        hostelRoom: { findMany: jest.fn().mockResolvedValue([{ id: "r1" }]) },
        hostelAllocation: { findMany: allocFindMany },
        user: { findMany: jest.fn().mockResolvedValue([]) },
      }).listAllocations(wide, undefined, "nobody");
      expect(out).toEqual([]);
      expect(allocFindMany).not.toHaveBeenCalled();
    });
  });
});
