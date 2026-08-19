// =============================================================================
// An admission chain nobody in the school could finish
// =============================================================================
// A parent applies through the public portal, pays the form fee, and the
// application enters a 3-stage maker-checker recorded on the row itself:
//
//     ADMIN (admission.review) → HR (workflow.review.hr) → PRINCIPAL (final)
//
// Each stage must be decided by a DIFFERENT person. Two separate faults meant
// that chain could not always be finished by the people who actually work at
// the school — and there is no reassign, no reset and no override, so an
// application that stalls stalls for ever.
//
// 1. A STAGE WITH NOBODY TO DECIDE IT. `workflow.review.hr` is held by exactly
//    one role, hr_manager, and a school need not employ one. A live tenant had
//    ZERO holders: every application it received could pass stage 0 and then
//    stop at stage 1 permanently, fee already taken. Fixed by resolving the
//    chain against the school's real staff at submit — a stage nobody can
//    decide is not a control, it is a dead end in front of the ones after it.
//
// 2. SPENDING A SIGNATURE YOU WERE GOING TO NEED. `admission.review` (stage 0)
//    is held by principal and hr_manager as well as the admin roles, while each
//    LATER stage has exactly one role. So a principal helping clear the intake
//    queue used up the only signature stage 2 would ever have. Live, before the
//    fix:
//
//      stage 0: PRINCIPAL approves  -> 201 {"currentStage":1}
//      stage 1: HR MANAGER approves -> 201 {"currentStage":2}
//      stage 2: PRINCIPAL           -> 403 "You have already acted"
//      application now              -> REVIEWING stage 2      (for ever)
//
//    Refused now at the point where it is still recoverable, with a message
//    that says what to do instead.
//
// 3. NO OPTIMISTIC LOCK on the write, which the generic workflow engine has and
//    documents. Two approvers deciding one stage at once both read `approvals:
//    []`, both pass the separation-of-duties check and both write. One approval
//    record is silently lost — and the approver whose record vanished is then
//    free to decide a LATER stage too. That is the SoD guarantee itself.
// =============================================================================

import { ConflictException } from "@nestjs/common";
import { AdmissionsService } from "../../src/admissions/admissions.service";
import type { Principal, TenantContext, TenantTx } from "../../src/integrity/integrity.foundation";

const ADMIN = "admission.review";
const HR = "workflow.review.hr";
const HEAD = "workflow.review.principal";

const who = (userId: string, permissions: string[]): Principal => ({
  schoolId: "school-A",
  userId,
  roles: [],
  permissions,
});

/** holders: permission -> the user ids that hold it in this school. */
function makeService(opts: {
  holders?: Record<string, string[]>;
  app?: Record<string, unknown>;
  writeCount?: number;
} = {}) {
  const {
    holders = { [ADMIN]: ["admin-1", "head-1"], [HR]: ["hr-1"], [HEAD]: ["head-1"] },
    writeCount = 1,
  } = opts;
  const app = {
    id: "app-1",
    status: "NEW",
    currentStage: 0,
    stages: null,
    approvals: [],
    applicantName: "Parent",
    applicantEmail: "p@example.com",
    childName: "Child",
    formFeeMinor: 0,
    ...(opts.app ?? {}),
  };
  const created: Record<string, unknown>[] = [];
  const tx = {
    user: {
      count: jest.fn(async (a: { where: Record<string, unknown> }) => {
        // Reads the permission key out of the nested role filter, and honours
        // the `id: { not }` exclusion the sole-approver check relies on.
        const key = (a.where as never as {
          roles: { some: { role: { permissions: { some: { permission: { key: string } } } } } };
        }).roles.some.role.permissions.some.permission.key;
        const exclude = (a.where.id as { not?: string } | undefined)?.not;
        return (holders[key] ?? []).filter((u) => u !== exclude).length;
      }),
    },
    school: { findFirst: jest.fn(async () => ({ id: "school-A", admissionFormFeeMinor: 0, paystackSubaccountCode: null })) },
    admissionApplication: {
      findFirst: jest.fn(async () => app),
      create: jest.fn(async (a: { data: Record<string, unknown> }) => {
        created.push(a.data);
        return { id: "app-1", status: "NEW" };
      }),
      updateMany: jest.fn(async () => ({ count: writeCount })),
      update: jest.fn(async () => ({})),
    },
  } as unknown as TenantTx;
  const db = { runAsTenant: <T>(_c: TenantContext, fn: (t: TenantTx) => Promise<T>) => fn(tx) };
  const service = new AdmissionsService(
    db as never,
    { record: jest.fn() } as never,
    { send: jest.fn() } as never,
    { isConfigured: () => false, initialize: jest.fn() } as never,
    { effective: jest.fn().mockResolvedValue({}) } as never,
    {} as never,
    { forSchool: jest.fn().mockResolvedValue({ currency: "NGN" }) } as never,
    // Documents follow an accepted family onto the roll; these suites do not
    // exercise that, so it is stubbed rather than mocked in detail.
    { promoteApplicationInTx: jest.fn().mockResolvedValue({ promoted: 0 }) } as never
  );
  return { service, tx, created };
}

describe("the chain a school can actually staff", () => {
  it("drops a stage the school has NOBODY for", async () => {
    // The live tenant: no hr_manager at all.
    const { service, created } = makeService({ holders: { [ADMIN]: ["admin-1"], [HR]: [], [HEAD]: ["head-1"] } });
    await service.submit({ schoolSlug: "s", applicantName: "P", applicantEmail: "p@e.com", childName: "C" });
    expect((created[0].stages as Array<{ key: string }>).map((s) => s.key)).toEqual(["ADMIN", "PRINCIPAL"]);
  });

  it("keeps every stage the school CAN staff", async () => {
    const { service, created } = makeService();
    await service.submit({ schoolSlug: "s", applicantName: "P", applicantEmail: "p@e.com", childName: "C" });
    expect((created[0].stages as Array<{ key: string }>).map((s) => s.key)).toEqual(["ADMIN", "HR", "PRINCIPAL"]);
  });

  it("keeps the FULL chain when it can staff none of it", async () => {
    // Fail closed. An application nobody can review must stay unreviewed, never
    // sail through because the checks were empty.
    const { service, created } = makeService({ holders: { [ADMIN]: [], [HR]: [], [HEAD]: [] } });
    await service.submit({ schoolSlug: "s", applicantName: "P", applicantEmail: "p@e.com", childName: "C" });
    expect((created[0].stages as Array<{ key: string }>)).toHaveLength(3);
  });
});

describe("spending a signature you are going to need", () => {
  it("refuses the principal at stage 0 when they are the only final approver", async () => {
    // THE defect, at the last moment it is still recoverable.
    const { service } = makeService();
    await expect(service.review(who("head-1", [ADMIN, HEAD]), "app-1", "APPROVE")).rejects.toBeInstanceOf(
      ConflictException,
    );
  });

  it("says which stage, and what to do instead", async () => {
    // A refusal an admissions clerk cannot act on is barely better than the
    // silent deadlock it replaced.
    const { service } = makeService();
    await expect(service.review(who("head-1", [ADMIN, HEAD]), "app-1", "APPROVE")).rejects.toThrow(
      /only Principal \(final\) approver.*leave the School administrator stage to a colleague, or appoint another/s,
    );
  });

  it("lets the ordinary admin through — they are nobody's only approver", async () => {
    const { service } = makeService();
    await expect(service.review(who("admin-1", [ADMIN]), "app-1", "APPROVE")).resolves.toMatchObject({
      currentStage: 1,
    });
  });

  it("lets the principal act at their OWN stage", async () => {
    // Being the only final approver is exactly why they must be free here.
    const { service } = makeService({
      app: { currentStage: 2, status: "REVIEWING", approvals: [{ approverId: "admin-1" }, { approverId: "hr-1" }] },
    });
    await expect(service.review(who("head-1", [ADMIN, HEAD]), "app-1", "APPROVE")).resolves.toMatchObject({
      status: "ACCEPTED",
    });
  });

  it("does NOT block a REJECTION", async () => {
    // Rejecting ends the application. There are no later stages left to strand,
    // and refusing to let somebody decline would be its own dead end.
    const { service } = makeService();
    await expect(service.review(who("head-1", [ADMIN, HEAD]), "app-1", "REJECT")).resolves.toMatchObject({
      status: "REJECTED",
    });
  });

  it("allows it when a SECOND person holds the later stage", async () => {
    // The rule is about being irreplaceable, not about being senior.
    const { service } = makeService({
      holders: { [ADMIN]: ["admin-1", "head-1"], [HR]: ["hr-1"], [HEAD]: ["head-1", "head-2"] },
    });
    await expect(service.review(who("head-1", [ADMIN, HEAD]), "app-1", "APPROVE")).resolves.toBeDefined();
  });
});

describe("two approvers at once", () => {
  it("refuses the second write rather than losing the first approval", async () => {
    // updateMany matched nothing: the row moved under us. Retrying blindly would
    // record an approval against a stage that has already been decided.
    const { service } = makeService({ writeCount: 0 });
    await expect(service.review(who("admin-1", [ADMIN]), "app-1", "APPROVE")).rejects.toBeInstanceOf(
      ConflictException,
    );
  });

  it("guards on the stage AND the status, which together are the version", async () => {
    const { service, tx } = makeService();
    await service.review(who("admin-1", [ADMIN]), "app-1", "APPROVE");
    expect((tx.admissionApplication.updateMany as jest.Mock).mock.calls[0][0].where).toMatchObject({
      id: "app-1",
      status: "NEW",
      currentStage: 0,
    });
  });
});
