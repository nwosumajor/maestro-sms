// =============================================================================
// A two-person rule with one person is a dead end, not a control
// =============================================================================
// Maker-checker is the mechanism most of this platform's money and access
// controls rest on: one person raises, a DIFFERENT person decides. Nothing
// checked that a different person exists.
//
// With one holder of the permission the request could be raised and decided by
// nobody, ever. It was created, it sat, and the only symptom was silence — made
// louder by the approval notices added in 2c6151b, which correctly send to
// nobody because the only candidate is the person who raised it.
//
// It is a reachable state, not a hypothetical: a school that never appointed a
// school_admin has exactly one fee.approve holder in its principal, and a school
// that deactivates one of two is back to one without anybody deciding to. (No
// school in the live database is currently in it — every one has at least two —
// so this is a trap rather than a live outage.)
//
// TWO CHANGES, and the split matters. Refusing at request time stops the dead
// record being created and names the fix. The anomalies report says it BEFORE
// anybody tries, which is the only version that helps a school that has not yet
// needed the control.
// =============================================================================

import { BadRequestException } from "@nestjs/common";
import { hasSecondApprover, holdersOf, noSecondApproverMessage } from "../../src/common/approvers";
import type { TenantTx } from "../../src/integrity/integrity.foundation";

const tx = (holders: string[]) =>
  ({
    userRole: { findMany: jest.fn().mockResolvedValue(holders.map((userId) => ({ userId }))) },
  }) as unknown as TenantTx;

describe("who can approve", () => {
  it("asks for the users whose ROLE grants the permission, in one query", async () => {
    const t = tx(["a"]);
    await holdersOf(t, "fee.approve");
    expect(t.userRole.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { role: { permissions: { some: { permission: { key: "fee.approve" } } } } },
      }),
    );
    expect((t.userRole.findMany as jest.Mock).mock.calls).toHaveLength(1);
  });

  it("deduplicates somebody who holds it through two roles", async () => {
    // A principal who is also a school_admin is still one person, and counting
    // them twice would report a working control that is not.
    await expect(holdersOf(tx(["a", "a", "b"]), "fee.approve")).resolves.toEqual(["a", "b"]);
  });
});

describe("is there a second approver", () => {
  it("yes when somebody else holds it", async () => {
    await expect(hasSecondApprover(tx(["me", "other"]), "fee.approve", "me")).resolves.toBe(true);
  });

  it("NO when the only holder is the person asking", async () => {
    await expect(hasSecondApprover(tx(["me"]), "fee.approve", "me")).resolves.toBe(false);
  });

  it("no when nobody holds it at all", async () => {
    await expect(hasSecondApprover(tx([]), "fee.approve", "me")).resolves.toBe(false);
  });

  it("yes when somebody else holds it and the asker does not", async () => {
    // A junior_admin raising something they cannot approve themselves: the rule
    // is satisfied, because a different person can decide.
    await expect(hasSecondApprover(tx(["other"]), "fee.approve", "me")).resolves.toBe(true);
  });
});

describe("what the school is told", () => {
  it("names the permission to grant, not just the refusal", () => {
    // "Forbidden" leaves an administrator guessing at a fix that is one role
    // assignment away and cannot be inferred from a permission string.
    const msg = noSecondApproverMessage("A salary change", "hr.salary.approve");
    expect(msg).toContain("hr.salary.approve");
    expect(msg).toContain("second member of staff");
    expect(msg).toContain("A salary change");
  });
});

describe("the money paths refuse before creating a dead record", () => {
  const read = (rel: string) =>
    require("node:fs").readFileSync(require("node:path").join(__dirname, "../../src", rel), "utf8") as string;

  it.each([
    ["a fee waiver", "fees/fee-ops.service.ts", "FEES_PERMISSIONS.FEE_APPROVE", "invoiceAdjustment.create"],
    ["a salary change", "hr/salary.service.ts", "HR_PERMISSIONS.HR_SALARY_APPROVE", "salaryChangeRequest.create"],
    ["an employment change", "hr/employment.service.ts", "HR_PERMISSIONS.HR_SALARY_APPROVE", "employmentChangeRequest.create"],
  ])("%s checks first", (_what, file, perm, createCall) => {
    const src = read(file);
    expect(src).toMatch(new RegExp(`hasSecondApprover\\(tx, ${perm.replace(".", "\\.")}, p\\.userId\\)`));
    // BEFORE the row is written, or the guard is decoration.
    //
    // Anchored on the CALL, not the bare name: the first occurrence of
    // "hasSecondApprover" in the file is its import, which is above everything
    // and made this comparison true no matter where the guard sat. Verified by
    // moving the guard after the create — which this now catches and the
    // earlier version did not.
    expect(src.indexOf("hasSecondApprover(tx,")).toBeGreaterThan(-1);
    expect(src.indexOf("hasSecondApprover(tx,")).toBeLessThan(src.indexOf(createCall));
  });

  it("throws rather than returning something that looks like success", () => {
    for (const f of ["fees/fee-ops.service.ts", "hr/salary.service.ts", "hr/employment.service.ts"]) {
      expect(read(f)).toMatch(/throw new BadRequestException\(noSecondApproverMessage\(/);
    }
    expect(new BadRequestException("x")).toBeInstanceOf(Error);
  });
});
