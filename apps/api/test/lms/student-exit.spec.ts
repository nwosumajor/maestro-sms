// =============================================================================
// Student exit — two people, and the access actually ends
// =============================================================================
// WHAT THIS REPLACES. Leaving was one button on the class roster: one click,
// one permission, no second person. It flipped ONE enrolment row and nothing
// else — the pupil's account stayed ACTIVE, so they could still sign in, and
// every other class they were in still listed them. There was no concept of
// leaving the SCHOOL at all, only of leaving a class, which is exactly why
// nothing ever revoked access.
//
// The properties below are the ones a school is relying on, so each is pinned
// rather than left to the shape of the code.
// =============================================================================

import { STUDENT_EXIT_CHAIN, WORKFLOW_PERMISSIONS, ROLE_PERMISSIONS } from "@sms/types";
import { StudentExitService } from "../../src/lms/student-exit.service";

// Bcrypt at cost factor 10 dominates this suite's runtime — that is the security
// parameter doing its job, not slow code, so the timeout moves rather than the
// cost. At the 5s default these pass alone and fail under full-suite
// parallelism, which teaches people to re-run a red suite instead of reading it.
jest.setTimeout(60_000);


const SCHOOL = "11111111-1111-1111-1111-111111111111";
const STUDENT = "22222222-2222-2222-2222-222222222222";

describe("the exit chain", () => {
  it("is TWO stages, and the second is the PRINCIPAL", () => {
    expect(STUDENT_EXIT_CHAIN).toHaveLength(2);
    expect(STUDENT_EXIT_CHAIN[1].permission).toBe(WORKFLOW_PERMISSIONS.STUDENT_EXIT_APPROVE);
  });

  it("gives the two stages DIFFERENT permissions, so one role cannot hold both halves", () => {
    // The engine already forbids the same PERSON acting twice. This is the
    // second line: the roles that raise an exit cannot also authorise it.
    expect(STUDENT_EXIT_CHAIN[0].permission).not.toBe(STUDENT_EXIT_CHAIN[1].permission);
  });

  it("grants the APPROVE half to the principal ALONE", () => {
    const holders = Object.entries(ROLE_PERMISSIONS)
      .filter(([, perms]) => (perms as readonly string[]).includes(WORKFLOW_PERMISSIONS.STUDENT_EXIT_APPROVE))
      .map(([role]) => role);
    expect(holders).toEqual(["principal"]);
  });

  it("gives NO role both halves — otherwise the chain deadlocks", () => {
    // THE TRAP THIS CATCHES, found live. The principal held both permissions,
    // so they were eligible for stage 1 as well. A principal opening the
    // approvals list sees "Stage 1/2" and clicks Approve — the natural action —
    // which spends their eligibility, and the engine then refuses them stage 2
    // because they have already acted. The exit is stuck with no one able to
    // finish it, and nothing in the UI explains why.
    //
    // Both stages passing individually is exactly why no other test saw it.
    const both = Object.entries(ROLE_PERMISSIONS)
      .filter(([, p]) => {
        const perms = p as readonly string[];
        return (
          perms.includes(WORKFLOW_PERMISSIONS.STUDENT_EXIT_REQUEST) &&
          perms.includes(WORKFLOW_PERMISSIONS.STUDENT_EXIT_APPROVE)
        );
      })
      .map(([r]) => r);
    expect(both).toEqual([]);
  });

  it("lets school_admin and head_teacher RAISE one, but not approve it", () => {
    for (const role of ["school_admin", "head_teacher"]) {
      const perms = (ROLE_PERMISSIONS as Record<string, readonly string[]>)[role];
      expect(perms).toContain(WORKFLOW_PERMISSIONS.STUDENT_EXIT_REQUEST);
      expect(perms).not.toContain(WORKFLOW_PERMISSIONS.STUDENT_EXIT_APPROVE);
    }
  });
});

describe("applying an exit", () => {
  afterEach(() => jest.restoreAllMocks());

  function makeService() {
    const userUpdate = jest.fn().mockResolvedValue({ count: 1 });
    const enrolUpdate = jest.fn().mockResolvedValue({ count: 3 });
    const audit = { record: jest.fn() };
    const tx = {
      user: { updateMany: userUpdate },
      enrollment: { updateMany: enrolUpdate },
      // A departure also releases the bed and the bus seat — see
      // exit-boarding.spec.ts for why those two lists are not paperwork.
      hostelAllocation: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
      transportAssignment: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
    };
    const svc = Object.create(StudentExitService.prototype) as StudentExitService;
    Object.assign(svc, { audit, db: {} });
    const apply = (svc as unknown as {
      applyExit: (t: unknown, s: string, a: string, st: string, k: string, r?: string) => Promise<void>;
    }).applyExit.bind(svc);
    return { apply, tx, userUpdate, enrolUpdate, audit };
  }

  it("ENDS ACCESS — this is the line login actually checks", async () => {
    // auth refuses any status but ACTIVE, so this single write is what stops a
    // departed pupil signing in. Nothing else in the old flow touched it.
    const { apply, tx, userUpdate } = makeService();
    await apply(tx, SCHOOL, "actor", STUDENT, "WITHDRAWN");
    expect(userUpdate.mock.calls[0][0].data).toMatchObject({ status: "EXITED" });
    expect(userUpdate.mock.calls[0][0].data.exitedAt).toBeInstanceOf(Date);
  });

  it("closes EVERY enrolment, not just the class the request came from", async () => {
    // The old bug exactly: a pupil in three classes withdrawn from one stayed
    // fully active in the other two.
    const { apply, tx, enrolUpdate } = makeService();
    await apply(tx, SCHOOL, "actor", STUDENT, "TRANSFERRED");
    expect(enrolUpdate.mock.calls[0][0].where).toEqual({ studentId: STUDENT, status: "ACTIVE" });
    expect(enrolUpdate.mock.calls[0][0].data.status).toBe("TRANSFERRED");
  });

  it("is guarded on ACTIVE, so a replayed reactor cannot overwrite a later status", async () => {
    const { apply, tx, userUpdate } = makeService();
    await apply(tx, SCHOOL, "actor", STUDENT, "WITHDRAWN");
    expect(userUpdate.mock.calls[0][0].where).toEqual({ id: STUDENT, status: "ACTIVE" });
  });

  it("audits the exit against the pupil", async () => {
    const { apply, tx, audit } = makeService();
    await apply(tx, SCHOOL, "actor", STUDENT, "GRADUATED", "end of SS3");
    expect(audit.record.mock.calls[0][0]).toMatchObject({
      action: "student.exit.applied",
      entityId: STUDENT,
    });
  });

  it("DELETES NOTHING — it writes only status columns", async () => {
    // A school still owes a leaver their records, and a departure that
    // destroyed report cards or invoices would be the more serious failure.
    const { apply, tx } = makeService();
    await apply(tx, SCHOOL, "actor", STUDENT, "WITHDRAWN");
    // The full set of things a departure touches. Listed rather than counted so
    // that adding a fifth is a deliberate edit here, not a silent widening.
    expect(Object.keys(tx)).toEqual([
      "user",
      "enrollment",
      "hostelAllocation",
      "transportAssignment",
    ]);
  });
});

describe("an exited pupil cannot get in", () => {
  // EXITED revokes access because auth ALLOWLISTS ACTIVE — anything else is
  // refused. That is the property, and it is worth pinning: switching either
  // check to a denylist ("status === 'SUSPENDED'") would silently hand every
  // leaver their access back, and no exit test would notice.
  let auth: string;
  beforeAll(async () => {
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    auth = readFileSync(join(__dirname, "../../src/foundation/auth.service.ts"), "utf8");
  });

  it("refuses LOGIN for any status but ACTIVE", () => {
    expect(auth).toMatch(/user\.status !== "ACTIVE"/);
  });

  it("KILLS A LIVE SESSION too — a pupil signed in when the exit lands is thrown out", () => {
    // Without this, an exit approved mid-morning left the pupil browsing until
    // they happened to sign out.
    expect(auth).toMatch(/u\.status !== "ACTIVE"\) return \{ revoked: true/);
  });
});

describe("the roster back door is shut", () => {
  it("refuses to un-enrol a pupil from their LAST class", async () => {
    // `enrollment.write` is held by junior_admin — the tier defined by having
    // no approval powers. Taking a pupil out of their only class removed them
    // from every register and print run while their account stayed ACTIVE:
    // an exit performed by one person, with none of an exit's guarantees.
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const src = readFileSync(join(__dirname, "../../src/lms/lms.service.ts"), "utf8");
    const fn = src.slice(src.indexOf("async setEnrollmentStatus"));
    expect(fn).toMatch(/status: "ACTIVE", NOT: \{ id: enr\.id \}/);
    expect(fn.slice(0, fn.indexOf("private async assertCapacity"))).toMatch(/ConflictException/);
  });
});

describe("there is no way to exit a pupil alone", () => {
  it("exposes no direct apply — the only path is the workflow", async () => {
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const controller = readFileSync(join(__dirname, "../../src/lms/lms.controller.ts"), "utf8");
    // The controller may RAISE an exit and READ one. It must not apply one.
    expect(controller).toContain("this.exits.request(");
    expect(controller).not.toContain("this.exits.applyExit");
    const service = readFileSync(join(__dirname, "../../src/lms/student-exit.service.ts"), "utf8");
    expect(service).toMatch(/private async applyExit/);
  });
});
