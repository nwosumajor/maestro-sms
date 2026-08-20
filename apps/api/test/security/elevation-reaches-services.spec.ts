// =============================================================================
// An elevation that let you through the door and not up to the desk
// =============================================================================
// CLAUDE.md: "the global PermissionGuard consults active PrivilegeGrant rows on
// a permission MISS ... so elevation is additive to the JWT". It was additive at
// the ROUTE and nowhere else. The guard allowed the request and left
// `principal.permissions` untouched, so every service that re-checks it — and
// fourteen do, because re-checking is the documented defence-in-depth pattern —
// still saw only the role permissions.
//
// The approval chains showed it worst, and by an unlucky combination:
//
//   * the decide ROUTE requires the generic `workflow.review`, which a
//     school_admin already holds. So the gate passed on the JWT and never
//     consulted grants at all;
//   * the ENGINE then checks the GRANULAR stage permission —
//     `workflow.review.principal` — against the same JWT array, and answers
//     "You are not the Principal (final) approver".
//
// So a school_admin holding an ACTIVE, correctly-issued, audited grant for
// exactly that permission was refused. Six chains end at the principal —
// staff requests including LEAVE, student exit, grade publish, LMS content
// publish, exam schedule and CBT answer release — and `principal` is the only
// role holding that permission. Elevation is the platform's designed answer to
// an absent principal, and for those six it did nothing.
//
// It would also have hidden the work: the approvals inbox filters on
// `p.permissions.includes(perm)` too, so an elevated approver could not see the
// item they had been elevated to decide.
// =============================================================================

import { isElevatable, WORKFLOW_PERMISSIONS } from "@sms/types";
import { activeGrantPermissions } from "../../src/auth/active-grants";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const SRC = join(__dirname, "../../src");
const GUARD = readFileSync(join(SRC, "auth/permission.guard.ts"), "utf8");

describe("the guard makes elevation additive to the JWT", () => {
  it("merges active grants into principal.permissions", () => {
    expect(GUARD).toMatch(/principal\.permissions = \[\.\.\.new Set\(\[\.\.\.principal\.permissions, \.\.\.granted\]\)\]/);
  });

  it("resolves ALL active grants, not just the one the route asked about", () => {
    // The old lookup took a single `permission` argument, so a grant for
    // anything checked deeper than the route was never even queried.
    expect(GUARD).toMatch(/private async activeGrantPermissions\(principal: Principal\): Promise<string\[\]>/);
    expect(GUARD).not.toMatch(/private async hasActiveGrant\(/);
  });

  it("resolves them BEFORE the permission gate", () => {
    // Otherwise the gate is evaluated against the un-merged array and the merge
    // only helps whatever runs after it.
    expect(GUARD.indexOf("const granted = await this.activeGrantPermissions")).toBeLessThan(
      GUARD.indexOf("throw new ForbiddenException()"),
    );
  });

  it("still filters out non-elevatable permissions — now provably, not textually", async () => {
    // The merge must not become a way around isElevatable: a tampered or legacy
    // ACTIVE row for platform.operate or a maker-checker permission would
    // otherwise be written straight into the principal.
    //
    // The rule moved out of the guard when the LOGIN/REFRESH claims came to need
    // the same answer, which is the whole reason it is one function now. That
    // makes it testable by calling it rather than by reading it.
    const rows = [
      { permission: "hr.read" },
      { permission: "platform.operate" },
      { permission: "fee.approve" },
      { permission: "rbac.manage" },
      { permission: "security.elevation.approve" },
      { permission: "attendance.write" },
    ];
    const tx = { privilegeGrant: { findMany: async () => rows } } as never;
    await expect(activeGrantPermissions(tx, "u-1")).resolves.toEqual(["hr.read", "attendance.write"]);
  });

  it("asks only for ACTIVE, unexpired grants belonging to that user", async () => {
    const findMany = jest.fn().mockResolvedValue([]);
    await activeGrantPermissions({ privilegeGrant: { findMany } } as never, "u-1");
    const where = findMany.mock.calls[0][0].where as { userId: string; status: string; expiresAt: { gt: Date } };
    expect(where.userId).toBe("u-1");
    expect(where.status).toBe("ACTIVE");
    expect(where.expiresAt.gt.getTime()).toBeLessThanOrEqual(Date.now());
  });

  it("degrades to no grants when the tenant runner returns a wrong SHAPE", async () => {
    // A `try` does not catch a wrong shape, and this runs in front of every
    // request — it must answer "no grants", never throw.
    await expect(activeGrantPermissions({ privilegeGrant: { findMany: async () => undefined } } as never, "u"))
      .resolves.toEqual([]);
  });

  it("fails closed when the grant lookup errors", () => {
    const fn = GUARD.slice(
      GUARD.indexOf("private async activeGrantPermissions"),
      GUARD.indexOf("private async recordElevatedUse"),
    );
    expect(fn).toMatch(/catch \{[\s\S]*?return \[\];/);
  });

  it("still records the elevated USE when the grant is what admitted the route", () => {
    // Same audit action as before, asked after the merge rather than during the
    // gate — so it reports the grant that mattered instead of re-deciding.
    //
    // It reports the permission that ACTUALLY admitted the route, which is why
    // this reads `satisfiedBy` rather than a route's first-listed permission: a
    // route may now accept any of several, and logging the wrong one would name
    // a grant the caller never used.
    expect(GUARD).toMatch(/satisfiedBy && granted\.includes\(satisfiedBy\) && !jwtPermissions\.includes\(satisfiedBy\)/);
    expect(GUARD).toMatch(/recordElevatedUse\(principal, satisfiedBy\)/);
    expect(GUARD).toMatch(/action: "security\.elevation\.used"/);
  });

  it("an audit failure never denies a request the gate allowed", () => {
    const fn = GUARD.slice(GUARD.indexOf("private async recordElevatedUse"));
    expect(fn).toMatch(/Never let an audit failure deny/);
  });
});

describe("the permissions this actually unblocks", () => {
  it("every stage permission in the chains is elevatable", () => {
    // If a stage permission were non-elevatable the chain could not be covered
    // at all, and the fix above would be silently useless for it.
    for (const perm of [
      WORKFLOW_PERMISSIONS.REVIEW_HEAD,
      WORKFLOW_PERMISSIONS.REVIEW_HR,
      WORKFLOW_PERMISSIONS.REVIEW_PRINCIPAL,
      WORKFLOW_PERMISSIONS.ATTENDANCE_AMEND_REVIEW,
    ]) {
      expect({ perm, elevatable: isElevatable(perm) }).toEqual({ perm, elevatable: true });
    }
  });

  it("the maker-checker authorities remain unlendable", () => {
    // The other half of the rule, unchanged: lending the approving half of a
    // two-person control removes the control rather than sharing the work.
    for (const perm of ["fee.approve", "hr.salary.approve", "rbac.manage", "security.elevation.approve"]) {
      expect({ perm, elevatable: isElevatable(perm) }).toEqual({ perm, elevatable: false });
    }
  });
});

describe("the services that re-check permissions", () => {
  // Not a demand that they stop — re-checking IS the defence-in-depth pattern.
  // The point is that there are enough of them that fixing the guard was the
  // only sane place, and that a future one inherits the fix for free.
  it("there are several, and they all read principal.permissions", () => {
    const files: string[] = [];
    const walk = (d: string) => {
      for (const e of readdirSync(d)) {
        const f = join(d, e);
        if (statSync(f).isDirectory()) walk(f);
        else if (f.endsWith(".service.ts")) files.push(f);
      }
    };
    walk(SRC);
    const rechecking = files.filter((f) => /p\.permissions\.includes\(/.test(readFileSync(f, "utf8")));
    expect(rechecking.length).toBeGreaterThanOrEqual(10);
  });

  it("the approval engine is one of them", () => {
    const engine = readFileSync(join(SRC, "workflow/workflow.service.ts"), "utf8");
    expect(engine).toMatch(/if \(!p\.permissions\.includes\(stage\.permission\)\)/);
  });
});

describe("the trail shows that a stand-in decided it", () => {
  const GUARD_SRC = readFileSync(join(SRC, "auth/permission.guard.ts"), "utf8");
  const ENGINE = readFileSync(join(SRC, "workflow/workflow.service.ts"), "utf8");

  it("the guard says WHICH permissions were lent", () => {
    expect(GUARD_SRC).toMatch(/principal\.elevated = granted;/);
  });

  it("the approval record is stamped when the stage authority was lent", () => {
    // `security.elevation.used` only fires when the grant admitted the ROUTE, and
    // for an approval the route is satisfied by the ordinary `workflow.review` a
    // school_admin already holds. Without this the grant and the decision it
    // enabled sit in the record with nothing connecting them.
    expect(ENGINE).toMatch(/viaElevation\?: boolean;/);
    expect(ENGINE).toMatch(/p\.elevated\?\.includes\(stage\.permission\) \? \{ viaElevation: true \} : \{\}/);
  });

  it("an ordinary approver is NOT stamped", () => {
    // The spread is conditional, so a principal approving their own stage leaves
    // the field absent rather than false — "not under cover" is the default.
    expect(ENGINE).not.toMatch(/viaElevation: false/);
  });
});
