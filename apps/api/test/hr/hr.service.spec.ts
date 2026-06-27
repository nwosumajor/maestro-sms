// =============================================================================
// HrService — salary encryption, decoration, and audit-coverage unit tests
// =============================================================================
// Proves the scoping/decoration logic the RLS layer backstops: salaries are
// ciphertext at rest and decrypted only on read, every read is audited (GR#5),
// and a compensation change is flagged in the audit trail WITHOUT leaking the
// value. Tenant isolation itself is covered by the RLS e2e suite.

import { HrService } from "../../src/hr/hr.service";
import { encryptField } from "../../src/foundation/field-crypto";
import type { Principal, TenantContext, TenantTx } from "../../src/integrity/integrity.foundation";

// A real (test-only) key so encrypt/decrypt actually round-trip and we can assert
// ciphertext-at-rest. Set before the service module reads it (it reads per-call).
beforeAll(() => {
  process.env.DATA_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64");
});
afterAll(() => {
  delete process.env.DATA_ENCRYPTION_KEY;
});

function makeService(over: {
  employees?: Array<Record<string, unknown>>;
  employee?: Record<string, unknown> | null;
  user?: Record<string, unknown> | null;
  users?: Array<Record<string, unknown>>;
}) {
  const upsert = jest.fn((args: { create?: Record<string, unknown>; update?: Record<string, unknown> }) =>
    Promise.resolve({ id: "e1", ...(args.create ?? {}), ...(args.update ?? {}) }),
  );
  const employeeUpdate = jest.fn((args: { data: Record<string, unknown> }) => Promise.resolve({ id: "e1", jobTitle: "Teacher", department: null, phoneEnc: null, addressEnc: null, nextOfKinEnc: null, nextOfKinPhoneEnc: null, bankNameEnc: null, bankAccountEnc: null, ...args.data }));
  const tx = {
    employee: {
      findMany: jest.fn().mockResolvedValue(over.employees ?? []),
      findFirst: jest.fn().mockResolvedValue(over.employee ?? null),
      upsert,
      update: employeeUpdate,
    },
    user: {
      findFirst: jest.fn().mockResolvedValue(over.user ?? null),
      findMany: jest.fn().mockResolvedValue(over.users ?? []),
    },
  } as unknown as TenantTx;
  const db = { runAsTenant: <T>(_c: TenantContext, fn: (t: TenantTx) => Promise<T>) => fn(tx) };
  const audit = { record: jest.fn().mockResolvedValue(undefined) };
  return { service: new HrService(db as never, audit as never), upsert, audit, tx, employeeUpdate };
}

const p = (userId = "hr-1"): Principal => ({ schoolId: "A", userId, roles: ["hr_clerk"], permissions: [] });

describe("HrService", () => {
  it("listEmployees decrypts salary, strips ciphertext, joins user, and audits the read", async () => {
    const { service, audit } = makeService({
      employees: [{ id: "e1", userId: "u1", jobTitle: "Teacher", salaryEnc: encryptField("500000", "A") }],
      users: [{ id: "u1", name: "Ada", email: "ada@t" }],
    });
    const res = await service.listEmployees(p());
    expect(res[0]).toMatchObject({ salaryMinor: 500000, user: { name: "Ada" } });
    expect(res[0]).not.toHaveProperty("salaryEnc"); // ciphertext never leaves the service
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: "hr.employee.list", entity: "employee" }),
      expect.anything(),
    );
  });

  it("getEmployee throws 404 when absent", async () => {
    const { service } = makeService({ employee: null });
    await expect(service.getEmployee(p(), "u-missing")).rejects.toThrow(/not found/i);
  });

  it("getMyProfile decrypts the caller's own personal fields; 404 with no record", async () => {
    const { service } = makeService({
      employee: { id: "e1", jobTitle: "Teacher", department: null, phoneEnc: encryptField("0801", "A"), addressEnc: null, nextOfKinEnc: null, nextOfKinPhoneEnc: null, bankNameEnc: encryptField("GTB", "A"), bankAccountEnc: null },
    });
    await expect(service.getMyProfile(p("u1"))).resolves.toMatchObject({ phone: "0801", bankName: "GTB", jobTitle: "Teacher" });
    const none = makeService({ employee: null });
    await expect(none.service.getMyProfile(p("u1"))).rejects.toThrow(/no employee record/i);
  });

  it("updateMyProfile stores the bank account ENCRYPTED at rest", async () => {
    const { service, employeeUpdate } = makeService({ employee: { id: "e1" } });
    await service.updateMyProfile(p("u1"), { bankAccount: "1234567890" });
    const data = employeeUpdate.mock.calls[0][0].data as Record<string, unknown>;
    expect(data.bankAccountEnc as string).toMatch(/^enc:v1:/);
    expect(data.bankAccountEnc as string).not.toContain("1234567890");
  });

  it("getEmployee audits the read and returns a decrypted salary", async () => {
    const { service, audit } = makeService({
      employee: { id: "e1", userId: "u1", jobTitle: "Teacher", salaryEnc: encryptField("750000", "A") },
    });
    await expect(service.getEmployee(p(), "u1")).resolves.toMatchObject({ salaryMinor: 750000 });
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: "hr.employee.read" }),
      expect.anything(),
    );
  });

  it("upsertEmployee throws 404 when the target user does not exist", async () => {
    const { service } = makeService({ user: null });
    await expect(
      service.upsertEmployee(p(), "u-missing", { jobTitle: "Teacher", startDate: "2026-01-01", salaryMinor: 100 }),
    ).rejects.toThrow(/user not found/i);
  });

  it("upsertEmployee sets the INITIAL salary as ciphertext on create (and audits created=true)", async () => {
    const { service, upsert, audit } = makeService({
      user: { id: "u1" },
      employee: null, // no existing record -> create path
    });
    await service.upsertEmployee(p(), "u1", { jobTitle: "Teacher", startDate: "2026-01-01", salaryMinor: 500000 });
    const writtenSalary = (upsert.mock.calls[0][0].create as Record<string, unknown>).salaryEnc as string;
    expect(writtenSalary).toMatch(/^enc:v1:/); // encrypted at rest, not plaintext
    expect(writtenSalary).not.toContain("500000");
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: "hr.employee.upsert", metadata: expect.objectContaining({ created: true }) }),
      expect.anything(),
    );
  });

  it("upsertEmployee on an EXISTING employee never writes salaryEnc (changes go via approval)", async () => {
    const { service, upsert } = makeService({
      user: { id: "u1" },
      employee: { id: "e1" }, // existing record -> update path
    });
    await service.upsertEmployee(p(), "u1", { jobTitle: "Senior Teacher", startDate: "2026-01-01", salaryMinor: 999999 });
    const update = upsert.mock.calls[0][0].update as Record<string, unknown>;
    expect(update).not.toHaveProperty("salaryEnc"); // salary is immutable via upsert
    expect(update).toMatchObject({ jobTitle: "Senior Teacher" });
  });
});
