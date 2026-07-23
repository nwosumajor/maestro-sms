// Member scan lookup — tenant scoping, roster-only output, audit.
import { MemberScanService } from "../../src/certificate/member-scan.service";
import type { Principal, TenantContext, TenantTx } from "../../src/integrity/integrity.foundation";

function makeService(over: {
  user?: Record<string, unknown> | null;
  enrolment?: { class: { name: string } } | null;
}) {
  const audit = { record: jest.fn().mockResolvedValue(undefined) };
  const tx = {
    user: { findFirst: jest.fn().mockResolvedValue(over.user ?? null) },
    enrollment: { findFirst: jest.fn().mockResolvedValue(over.enrolment ?? null) },
  } as unknown as TenantTx;
  const db = { runAsTenant: <T>(_c: TenantContext, fn: (t: TenantTx) => Promise<T>) => fn(tx) };
  return { service: new MemberScanService(db as never, audit as never), audit, tx };
}

const staff: Principal = { schoolId: "S", userId: "u-staff", roles: ["teacher"], permissions: ["member.scan"] };

describe("MemberScanService", () => {
  it("resolves a student to roster-level info and AUDITS the scan", async () => {
    const { service, audit } = makeService({
      user: {
        id: "stu-1",
        uniqueId: "SMS-ABC",
        name: "Ada Obi",
        status: "ACTIVE",
        roles: [{ role: { name: "student" } }],
        studentProfile: { admissionNumber: "2026/0001" },
      },
      enrolment: { class: { name: "JSS1" } },
    });
    const res = await service.resolve(staff, "SMS-ABC");
    expect(res).toMatchObject({
      userId: "stu-1",
      name: "Ada Obi",
      role: "student",
      admissionNumber: "2026/0001",
      className: "JSS1",
      status: "ACTIVE",
    });
    // NEVER leaks medical/PII — the shape has no such fields.
    expect(Object.keys(res).sort()).toEqual(
      ["admissionNumber", "className", "name", "role", "status", "uniqueId", "userId"].sort(),
    );
    expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({ action: "member.scan", entityId: "stu-1" }), expect.anything());
  });

  it("404s for a code not in THIS school (no cross-tenant existence disclosure)", async () => {
    const { service, audit } = makeService({ user: null }); // RLS hid the foreign user
    await expect(service.resolve(staff, "SMS-FOREIGN")).rejects.toMatchObject({ status: 404 });
    // A miss is NOT audited as a resolved scan.
    expect(audit.record).not.toHaveBeenCalled();
  });

  it("labels a staff member by their non-student role", async () => {
    const { service } = makeService({
      user: {
        id: "t-1", uniqueId: "SMS-TCH", name: "Mr Bello", status: "ACTIVE",
        roles: [{ role: { name: "teacher" } }], studentProfile: null,
      },
    });
    const res = await service.resolve(staff, "SMS-TCH");
    expect(res.role).toBe("teacher");
    expect(res.admissionNumber).toBeNull();
    expect(res.className).toBeNull();
  });
});
