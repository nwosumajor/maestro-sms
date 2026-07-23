// Member scan lookup — tenant scoping, roster-only output, audit.
import { MemberScanService } from "../../src/certificate/member-scan.service";
import type { Principal, TenantContext, TenantTx } from "../../src/integrity/integrity.foundation";

function makeService(over: {
  user?: Record<string, unknown> | null;
  enrolment?: { classId: string; class: { name: string } } | null;
}) {
  const audit = { record: jest.fn().mockResolvedValue(undefined) };
  const scanEventCreate = jest.fn().mockResolvedValue({ id: "se-1" });
  const sessionUpsert = jest.fn().mockResolvedValue({ id: "sess-1" });
  const execRaw = jest.fn().mockResolvedValue(1);
  const tx = {
    user: { findFirst: jest.fn().mockResolvedValue(over.user ?? null) },
    enrollment: { findFirst: jest.fn().mockResolvedValue(over.enrolment ?? null) },
    scanEvent: { create: scanEventCreate },
    attendanceSession: { upsert: sessionUpsert },
    $executeRaw: execRaw,
  } as unknown as TenantTx;
  const db = { runAsTenant: <T>(_c: TenantContext, fn: (t: TenantTx) => Promise<T>) => fn(tx) };
  return { service: new MemberScanService(db as never, audit as never), audit, tx, scanEventCreate, sessionUpsert, execRaw };
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
      enrolment: { classId: "c-1", class: { name: "JSS1" } },
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

describe("MemberScanService.record — actions", () => {
  const studentUser = {
    id: "stu-1", uniqueId: "SMS-ABC", name: "Ada Obi", status: "ACTIVE",
    roles: [{ role: { name: "student" } }], studentProfile: { admissionNumber: "2026/0001" },
  };

  it("CHECK_IN marks a student present in their class and records a scan_event", async () => {
    const { service, scanEventCreate, sessionUpsert, execRaw } = makeService({
      user: studentUser,
      enrolment: { classId: "c-1", class: { name: "JSS1" } },
    });
    const res = await service.record(staff, "SMS-ABC", "CHECK_IN", null);
    expect(scanEventCreate).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ purpose: "CHECK_IN", memberId: "stu-1" }) }),
    );
    expect(sessionUpsert).toHaveBeenCalled();
    expect(execRaw).toHaveBeenCalled(); // the PRESENT upsert
    expect(res.attendanceMarkedClass).toBe("JSS1");
  });

  it("CHECK_IN of a student with NO class records the event but marks no register", async () => {
    const { service, sessionUpsert } = makeService({ user: studentUser, enrolment: null });
    const res = await service.record(staff, "SMS-ABC", "CHECK_IN", null);
    expect(sessionUpsert).not.toHaveBeenCalled();
    expect(res.attendanceMarkedClass).toBeNull();
    expect(res.attendanceNote).toMatch(/no active class/i);
  });

  it("CHECK_IN of STAFF records the event but never touches attendance", async () => {
    const { service, sessionUpsert } = makeService({
      user: { id: "t-1", uniqueId: "SMS-T", name: "Mr B", status: "ACTIVE", roles: [{ role: { name: "teacher" } }], studentProfile: null },
    });
    const res = await service.record(staff, "SMS-T", "CHECK_IN", null);
    expect(sessionUpsert).not.toHaveBeenCalled();
    expect(res.attendanceMarkedClass).toBeNull();
  });

  it("LIBRARY records an event but does NOT mark attendance", async () => {
    const { service, scanEventCreate, sessionUpsert } = makeService({
      user: studentUser, enrolment: { classId: "c-1", class: { name: "JSS1" } },
    });
    const res = await service.record(staff, "SMS-ABC", "LIBRARY", null);
    expect(scanEventCreate).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ purpose: "LIBRARY" }) }),
    );
    expect(sessionUpsert).not.toHaveBeenCalled();
    expect(res.attendanceMarkedClass).toBeNull();
  });

  it("404s (no record) for a code not in this school", async () => {
    const { service, scanEventCreate } = makeService({ user: null });
    await expect(service.record(staff, "SMS-FOREIGN", "CHECK_IN", null)).rejects.toMatchObject({ status: 404 });
    expect(scanEventCreate).not.toHaveBeenCalled();
  });
});
