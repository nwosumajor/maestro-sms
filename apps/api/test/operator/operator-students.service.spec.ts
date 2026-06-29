// =============================================================================
// OperatorService.listSchoolStudents — cross-tenant student view unit test
// =============================================================================
// Proves the super_admin enrolled-students view groups a student's active classes,
// joins the admission number, sorts by name, and audits the cross-tenant PII read.

import { OperatorService } from "../../src/operator/operator.service";
import type { Principal, TenantContext, TenantTx } from "../../src/integrity/integrity.foundation";

function makeService() {
  const audit = { record: jest.fn().mockResolvedValue(undefined) };
  const tx = {
    school: { findFirst: jest.fn().mockResolvedValue({ id: "S" }) },
    enrollment: {
      findMany: jest.fn().mockResolvedValue([
        { student: { id: "s1", name: "Bola", email: "bola@t" }, class: { name: "JSS1" } },
        { student: { id: "s1", name: "Bola", email: "bola@t" }, class: { name: "Choir" } },
        { student: { id: "s2", name: "Ada", email: "ada@t" }, class: { name: "JSS2" } },
      ]),
    },
    studentProfile: {
      findMany: jest.fn().mockResolvedValue([{ studentId: "s1", admissionNumber: "ADM-1" }]),
    },
  } as unknown as TenantTx;
  const db = { runAsTenant: <T>(_c: TenantContext, fn: (t: TenantTx) => Promise<T>) => fn(tx) };
  const entitlements = {} as never;
  const service = new OperatorService(db as never, audit as never, entitlements);
  return { service, audit };
}

const op: Principal = { schoolId: "OP", userId: "super-1", roles: ["super_admin"], permissions: ["platform.operate"] };

describe("OperatorService.listSchoolStudents", () => {
  it("groups active classes per student, joins admission number, sorts by name, audits", async () => {
    const { service, audit } = makeService();
    const res = await service.listSchoolStudents(op, "S");
    // Sorted: Ada before Bola.
    expect(res.map((s) => s.name)).toEqual(["Ada", "Bola"]);
    const bola = res.find((s) => s.id === "s1")!;
    expect(bola.classes.sort()).toEqual(["Choir", "JSS1"]);
    expect(bola.admissionNumber).toBe("ADM-1");
    expect(res.find((s) => s.id === "s2")!.admissionNumber).toBeNull();
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: "operator.students.view", entity: "school" }),
      expect.anything(),
    );
  });
});
