// =============================================================================
// An employment record carries the person's name — on BOTH reads
// =============================================================================
// `employee` has no name of its own; it hangs off `user`, and `listEmployees`
// says exactly that in a comment and joins it. `getEmployee` did not, so
// `EmployeeDto.user` was declared, populated on one read and absent on the
// other — classic sibling asymmetry, with the correct one written first and its
// reasoning recorded.
//
// The cost was visible on screen. The staff detail page had no name to render
// and scavenged one from whichever of five UNRELATED lists happened to carry a
// row — checklists, documents, training, appraisals, discipline — falling back
// to the literal "Staff member". Measured live before the fix, two real
// employees (hr@ and board@demo.school, neither holding any of those five)
// both rendered "Staff member" as the page title.
//
// It was invisible because the handler declared no return type. Annotating it
// `: Promise<EmployeeDto>` made the compiler compare what the service returns
// against what the DTO promises, and it failed immediately — which is the whole
// point of the type spine, and why 83 unannotated JSON reads are worth closing.
// =============================================================================

import { HrService } from "../../src/hr/hr.service";
import type { Principal, TenantContext, TenantTx } from "../../src/integrity/integrity.foundation";

function makeService(employee: Record<string, unknown> | null, user: Record<string, unknown> | null) {
  const tx = {
    employee: {
      findFirst: jest.fn().mockResolvedValue(employee),
      findMany: jest.fn().mockResolvedValue(employee ? [employee] : []),
    },
    user: {
      findFirst: jest.fn().mockResolvedValue(user),
      findMany: jest.fn().mockResolvedValue(user ? [{ id: "u1", ...user }] : []),
    },
  } as unknown as TenantTx;
  const db = { runAsTenant: <T>(_c: TenantContext, fn: (t: TenantTx) => Promise<T>) => fn(tx) };
  return new HrService(db as never, { record: jest.fn().mockResolvedValue(undefined) } as never);
}

const EMPLOYEE = {
  id: "e1",
  userId: "u1",
  jobTitle: "Teacher",
  department: null,
  employmentType: "FULL_TIME",
  startDate: new Date("2024-01-01"),
  status: "ACTIVE",
  salaryEnc: null,
};
const USER = { name: "Ada Lovelace", email: "ada@example.school" };
const p: Principal = { schoolId: "A", userId: "hr-1", roles: ["hr_clerk"], permissions: [] };

describe("an employment record carries the person's name", () => {
  it("getEmployee returns the user, so a page has a name to show", async () => {
    const one = await makeService(EMPLOYEE, USER).getEmployee(p, "u1");
    expect(one.user).toEqual(USER);
  });

  it("the single read and the list read agree — neither may be the only one that joins", async () => {
    const svc = makeService(EMPLOYEE, USER);
    const [one, list] = await Promise.all([svc.getEmployee(p, "u1"), svc.listEmployees(p)]);
    expect(list).toHaveLength(1);
    // The asymmetry is the defect, so the assertion is about AGREEMENT rather
    // than about either read on its own.
    expect(one.user).toEqual(list[0].user);
  });

  it("a missing user row is null, not an absent field", async () => {
    // Null is a fact the caller can render ("—"); an absent field is a contract
    // that quietly does not hold, which is what shipped.
    const one = await makeService(EMPLOYEE, null).getEmployee(p, "u1");
    expect(one).toHaveProperty("user");
    expect(one.user).toBeNull();
  });
});
