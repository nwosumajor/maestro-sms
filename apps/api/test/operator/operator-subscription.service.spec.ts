// =============================================================================
// OperatorService.setSubscription — cross-tenant audit isolation (regression)
// =============================================================================
// REGRESSION: a super_admin in school A changing school B's subscription must
// write the subscription row under B's tenant (RLS GUC = B) but the AUDIT row
// under A's own tenant — never inside B's transaction. Recording the operator's
// own schoolId inside the B-scoped tx made Postgres reject the audit_log INSERT
// (RLS WITH CHECK: schoolId ≠ current GUC) → a live 500 when changing a freshly
// created school's plan. This guards the two-transaction structure so the audit
// can't drift back inside the target-school tx.

import { OperatorService } from "../../src/operator/operator.service";
import type { Principal, TenantContext, TenantTx } from "../../src/integrity/integrity.foundation";

const OPERATOR_SCHOOL = "school-A";
const TARGET_SCHOOL = "school-B";

function makeService() {
  // Record the GUC school of every runAsTenant call, in order.
  const txSchools: string[] = [];
  const tx = {
    school: { findFirst: jest.fn().mockResolvedValue({ id: TARGET_SCHOOL }) },
    schoolSubscription: {
      findFirst: jest.fn().mockResolvedValue({ id: "sub-1" }),
      update: jest.fn().mockResolvedValue({}),
      create: jest.fn().mockResolvedValue({}),
    },
  } as unknown as TenantTx;
  const db = {
    runAsTenant: jest.fn(<T>(ctx: TenantContext, fn: (t: TenantTx) => Promise<T>) => {
      txSchools.push(ctx.schoolId);
      return fn(tx);
    }),
  };
  const audit = { record: jest.fn().mockResolvedValue(undefined) };
  const entitlements = {
    invalidate: jest.fn(),
    resolve: jest.fn().mockResolvedValue({}),
    dtoFrom: jest.fn().mockReturnValue({ schoolId: TARGET_SCHOOL, plan: "STANDARD" }),
  };
  const service = new OperatorService(db as never, audit as never, entitlements as never, { client: null } as never);
  return { service, db, audit, entitlements, txSchools };
}

const operator: Principal = { schoolId: OPERATOR_SCHOOL, userId: "op-1", roles: ["super_admin"], permissions: ["platform.operate"] };

describe("OperatorService.setSubscription cross-tenant audit isolation", () => {
  it("writes the subscription under the TARGET tenant and the audit under the OPERATOR's own tenant", async () => {
    const { service, audit, entitlements, txSchools } = makeService();

    await service.setSubscription(operator, TARGET_SCHOOL, { plan: "STANDARD", overrides: { enabled: [], disabled: [] } });

    // Two separate transactions: the write scoped to B, the audit scoped to A.
    expect(txSchools).toEqual([TARGET_SCHOOL, OPERATOR_SCHOOL]);

    // The audit row carries the operator's own schoolId (so it satisfies A's GUC)
    // and records the affected school only in metadata.
    expect(audit.record).toHaveBeenCalledTimes(1);
    const entry = (audit.record as jest.Mock).mock.calls[0][0];
    expect(entry.schoolId).toBe(OPERATOR_SCHOOL);
    expect(entry.action).toBe("operator.subscription.set");
    expect(entry.metadata.targetSchoolId).toBe(TARGET_SCHOOL);

    // Entitlement cache invalidated for the TARGET school.
    expect(entitlements.invalidate).toHaveBeenCalledWith(TARGET_SCHOOL);
  });
});
