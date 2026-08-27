// =============================================================================
// A pupil told the classmate in front of them is "not in this school"
// =============================================================================
// A pupil may only file a complaint against a CLASSMATE — `listFileTargets`
// scopes STUDENT targets to their own classes, deliberately, so that filing does
// not hand every child a searchable roster of 900 minors.
//
// The consequence is real: a child bullied by someone in another year, on the
// bus or in the boarding house cannot file at all. And the ONLY place they would
// ever learn that was the refusal — which said "The named person is not in this
// school", about somebody standing in front of them.
//
// Measured live, driving a path that had never run (all four discipline tables
// were empty): a pupil with no classmates got `0 target(s)` and filing against a
// real pupil of the same school answered
// `404 {"message":"The named person is not in this school"}`.
//
// The two branches must stay INDISTINGUISHABLE — telling "out of your scope"
// apart from "no such id" lets a pupil probe ids for who exists. What they must
// not do is make a positive claim that is untrue: the same defect this repo
// records for `403 "Invoice not found"`, pointing the other way.
// =============================================================================

import { NotFoundException } from "@nestjs/common";
import { DisciplineService } from "../../src/discipline/discipline.service";

describe("a refusal that names the way out", () => {
  it("says the same thing to a pupil whether the target exists or not", async () => {
    const missing = await refusalFor({ targetExists: false, canManage: false });
    const outOfScope = await refusalFor({ targetExists: true, canManage: false });
    // Byte-identical, or the refusal becomes a probe.
    expect(missing).toBe(outOfScope);
  });

  it("no longer claims a classmate-of-the-school is not in the school", async () => {
    const msg = await refusalFor({ targetExists: true, canManage: false });
    expect(msg).not.toMatch(/not in this school/i);
  });

  it("tells the pupil what they can actually do instead", async () => {
    // The scope restriction is the design; being told about it is the fix. A
    // child who cannot file needs a human, and this is the only place they hear
    // that there is one.
    const msg = await refusalFor({ targetExists: true, canManage: false });
    expect(msg).toMatch(/your own classes/i);
    expect(msg).toMatch(/teacher or the school office/i);
  });

  it("tells a manager the plain truth, because they have no scope to leak", async () => {
    // Staff may name anyone, so "no such person" discloses nothing they could
    // not already establish — and is the useful answer for a bad id.
    const msg = await refusalFor({ targetExists: false, canManage: true });
    expect(msg).toMatch(/No such person/i);
  });
});

async function refusalFor(opts: { targetExists: boolean; canManage: boolean }): Promise<string> {
  const tx = {
    user: { findFirst: async () => (opts.targetExists ? { id: "target" } : null) },
  };
  const svc = Object.create(DisciplineService.prototype) as DisciplineService;
  Object.assign(svc, {
    db: { runAsTenant: async (_c: unknown, fn: (t: unknown) => unknown) => fn(tx) },
    audit: { record: async () => undefined },
    notifications: { enqueue: async () => undefined },
  });
  // `canManage` and `isAllowedTarget` are the two things that decide reachability.
  (svc as unknown as { canManage: () => boolean }).canManage = () => opts.canManage;
  (svc as unknown as { isAllowedTarget: () => Promise<boolean> }).isAllowedTarget = async () => false;

  try {
    await (svc as unknown as {
      file: (p: unknown, i: unknown) => Promise<unknown>;
    }).file({ userId: "filer", schoolId: "s1", roles: ["student"], permissions: [] }, {
      subject: "probe",
      againstId: "target",
      againstType: "STUDENT",
    });
  } catch (e) {
    expect(e).toBeInstanceOf(NotFoundException);
    return (e as NotFoundException).message;
  }
  throw new Error("expected a refusal");
}
