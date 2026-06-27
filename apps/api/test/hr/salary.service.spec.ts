// =============================================================================
// SalaryService — maker-checker + history unit tests
// =============================================================================

import { SalaryService } from "../../src/hr/salary.service";
import type { Principal, TenantContext, TenantTx } from "../../src/integrity/integrity.foundation";

beforeAll(() => {
  process.env.DATA_ENCRYPTION_KEY = Buffer.alloc(32, 5).toString("base64");
});
afterAll(() => {
  delete process.env.DATA_ENCRYPTION_KEY;
});

function makeService(over: {
  employee?: Record<string, unknown> | null;
  change?: Record<string, unknown> | null;
} = {}) {
  const changeCreate = jest.fn(({ data }: { data: Record<string, unknown> }) => Promise.resolve({ id: "sc1", status: "PENDING", decidedById: null, decidedAt: null, createdAt: new Date(), effectiveDate: null, reason: null, ...data }));
  const changeUpdate = jest.fn().mockResolvedValue({});
  const employeeUpdate = jest.fn().mockResolvedValue({});
  const tx = {
    employee: {
      findFirst: jest.fn().mockResolvedValue(over.employee ?? null),
      findMany: jest.fn().mockResolvedValue([]),
      update: employeeUpdate,
    },
    salaryChangeRequest: {
      create: changeCreate,
      findFirst: jest.fn().mockResolvedValue(over.change ?? null),
      findMany: jest.fn().mockResolvedValue([]),
      update: changeUpdate,
    },
    user: { findMany: jest.fn().mockResolvedValue([]) },
  } as unknown as TenantTx;
  const db = { runAsTenant: <T>(_c: TenantContext, fn: (t: TenantTx) => Promise<T>) => fn(tx) };
  const audit = { record: jest.fn().mockResolvedValue(undefined) };
  return { service: new SalaryService(db as never, audit as never), changeCreate, changeUpdate, employeeUpdate };
}

const p = (userId = "hr1"): Principal => ({ schoolId: "A", userId, roles: [], permissions: [] });

describe("SalaryService", () => {
  it("requestChange creates a PENDING row with the new salary ENCRYPTED at rest", async () => {
    const { service, changeCreate } = makeService({ employee: { id: "e1", salaryEnc: null } });
    await service.requestChange(p(), "e1", { newSalaryMinor: 600000 });
    const data = changeCreate.mock.calls[0][0].data as Record<string, unknown>;
    expect(data.status).toBe("PENDING");
    expect(data.newSalaryEnc as string).toMatch(/^enc:v1:/);
    expect(data.newSalaryEnc as string).not.toContain("600000");
  });

  it("requestChange 404s for an unknown employee", async () => {
    const { service } = makeService({ employee: null });
    await expect(service.requestChange(p(), "missing", { newSalaryMinor: 1 })).rejects.toThrow(/not found/i);
  });

  it("the SAME person cannot approve their own salary request (maker-checker)", async () => {
    const { service } = makeService({ change: { id: "sc1", status: "PENDING", requestedById: "hr1", employeeId: "e1", newSalaryEnc: null } });
    await expect(service.decide(p("hr1"), "sc1", true)).rejects.toThrow(/different person/i);
  });

  it("a DIFFERENT approver applies the new salary to the employee on approval", async () => {
    const { service, employeeUpdate, changeUpdate } = makeService({
      change: { id: "sc1", status: "PENDING", requestedById: "hr1", employeeId: "e1", oldSalaryEnc: null, newSalaryEnc: "enc:v1:xyz", reason: null, effectiveDate: null, decidedById: null, decidedAt: null, createdAt: new Date() },
    });
    await service.decide(p("hr2"), "sc1", true);
    expect(changeUpdate).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: "APPROVED", decidedById: "hr2" }) }));
    expect(employeeUpdate).toHaveBeenCalledWith(expect.objectContaining({ where: { id: "e1" }, data: { salaryEnc: "enc:v1:xyz" } }));
  });

  it("a rejection does NOT touch the employee record", async () => {
    const { service, employeeUpdate, changeUpdate } = makeService({
      change: { id: "sc1", status: "PENDING", requestedById: "hr1", employeeId: "e1", oldSalaryEnc: null, newSalaryEnc: "enc:v1:xyz", reason: null, effectiveDate: null, decidedById: null, decidedAt: null, createdAt: new Date() },
    });
    await service.decide(p("hr2"), "sc1", false);
    expect(changeUpdate).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: "REJECTED" }) }));
    expect(employeeUpdate).not.toHaveBeenCalled();
  });
});
