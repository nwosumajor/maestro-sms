// =============================================================================
// Five requests that needed a second person, and told nobody
// =============================================================================
// The approval ENGINE was silent (fixed in 491fd87), but five maker-checker
// paths do not route through it — they implement the two-person rule in their
// own service — and every one of them created a record and announced it to
// nobody:
//
//   an invoice DISCOUNT or WAIVER      a different fee.approve holder
//   a SALARY change                    a different hr.salary.approve holder
//   an EMPLOYMENT change               a different hr.salary.approve holder
//   an EXEAT — a boarder leaving site  hostel.manage
//   an ERASURE request                 privacy.erasure.review, on a statutory clock
//
// One helper rather than five hand-rolled blocks, because five call sites are
// five chances to forget — which is precisely how all five came to be silent in
// the first place.
//
// Recipients come from the PERMISSION, not a role list: a school that grants
// fee.approve to a bursar instead of the principal still gets told, and the
// notice cannot drift from the guard on the endpoint that approves, because
// both name the same string.
// =============================================================================

import { NotificationService } from "../../src/notifications/notification.service";
import type { TenantContext, TenantTx } from "../../src/integrity/integrity.foundation";

const ACTOR: TenantContext = { schoolId: "A", userId: "requester-1" };

function make(holders: string[]) {
  const userRole = { findMany: jest.fn().mockResolvedValue(holders.map((userId) => ({ userId }))) };
  const s = Object.create(NotificationService.prototype) as NotificationService;
  const enqueueMany = jest.fn().mockResolvedValue({ created: holders.length, failed: 0 });
  Object.assign(s, {
    db: {
      runAsTenantReadOnly: jest.fn(async (_c: TenantContext, fn: (t: TenantTx) => unknown) =>
        fn({ userRole } as unknown as TenantTx),
      ),
    },
    logger: { warn: jest.fn() },
  });
  (s as unknown as { enqueueMany: unknown }).enqueueMany = enqueueMany;
  (s as unknown as { ctx: unknown }).ctx = (c: TenantContext) => c;
  return { s, userRole, enqueueMany };
}

const MSG = { type: "WORKFLOW_UPDATE", title: "t", body: "b" };

describe("telling the people who can act", () => {
  it("resolves them from the permission, not from a role list", async () => {
    const { s, userRole } = make(["bursar-1"]);
    await s.notifyPermissionHolders(ACTOR, "fee.approve", MSG);
    expect(userRole.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { role: { permissions: { some: { permission: { key: "fee.approve" } } } } },
      }),
    );
  });

  it("excludes the person who raised it", async () => {
    // SECURITY: every one of these is a two-person rule. The endpoint refuses
    // the requester, so inviting them would point somebody at a button that
    // cannot work.
    const { s, enqueueMany } = make(["approver-1", "requester-1"]);
    await s.notifyPermissionHolders(ACTOR, "hr.salary.approve", MSG, { exclude: ["requester-1"] });
    expect(enqueueMany.mock.calls[0][1]).toEqual(["approver-1"]);
  });

  it("sends nothing when the exclusion empties the list", async () => {
    // A one-person school: the only approver is the requester. Silence is right
    // — there is nobody who may act.
    const { s, enqueueMany } = make(["requester-1"]);
    await expect(s.notifyPermissionHolders(ACTOR, "fee.approve", MSG, { exclude: ["requester-1"] })).resolves.toBe(0);
    expect(enqueueMany).not.toHaveBeenCalled();
  });

  it("never raises — the thing being announced has already happened", async () => {
    const { s } = make(["a"]);
    (s as unknown as { enqueueMany: jest.Mock }).enqueueMany.mockRejectedValue(new Error("queue down"));
    await expect(s.notifyPermissionHolders(ACTOR, "fee.approve", MSG)).resolves.toBe(0);
  });

  it("returns how many were told", async () => {
    const { s } = make(["a", "b"]);
    await expect(s.notifyPermissionHolders(ACTOR, "fee.approve", MSG)).resolves.toBe(2);
  });
});

// -----------------------------------------------------------------------------
// The WIRING. Asserting the helper alone would pass with every call site
// deleted — the mistake I made on the workflow engine an hour earlier, where
// five green mutations hid a function connected to nothing.
// -----------------------------------------------------------------------------
describe("each maker-checker path calls it", () => {
  const read = (rel: string) =>
    require("node:fs").readFileSync(require("node:path").join(__dirname, "../../src", rel), "utf8") as string;

  it.each([
    ["an invoice waiver", "fees/fee-ops.service.ts", "FEES_PERMISSIONS.FEE_APPROVE"],
    ["a salary change", "hr/salary.service.ts", "HR_PERMISSIONS.HR_SALARY_APPROVE"],
    ["an employment change", "hr/employment.service.ts", "HR_PERMISSIONS.HR_SALARY_APPROVE"],
    ["an exeat", "hostel/hostel.service.ts", "HOSTEL_PERMISSIONS.HOSTEL_MANAGE"],
    ["an erasure request", "privacy/privacy.service.ts", "PRIVACY_PERMISSIONS.ERASURE_REVIEW"],
  ])("%s tells the holders of the permission that decides it", (_what, file, perm) => {
    const src = read(file);
    expect(src).toMatch(/notifyPermissionHolders\(/);
    const call = src.slice(src.indexOf("notifyPermissionHolders("), src.indexOf("notifyPermissionHolders(") + 600);
    expect(call).toContain(perm);
    // And never invites the requester to approve their own.
    expect(call).toMatch(/exclude: \[p\.userId\]/);
  });

  it("names the SAME permission the approving endpoint is guarded by", () => {
    // The reason recipients are resolved from a permission rather than a role
    // list: these two cannot drift apart while they name one string.
    expect(read("fees/fees.controller.ts")).toMatch(/FEES_PERMISSIONS\.FEE_APPROVE/);
    expect(read("hr/employment.controller.ts")).toMatch(/HR_PERMISSIONS\.HR_SALARY_APPROVE/);
    expect(read("privacy/privacy.controller.ts")).toMatch(/PRIVACY_PERMISSIONS\.ERASURE_REVIEW/);
  });
});
