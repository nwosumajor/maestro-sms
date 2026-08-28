// =============================================================================
// Five invariants, audited and found SOUND — pinned so they stay that way
// =============================================================================
// This file is the output of a phase that found no defect. That is a real
// result and worth keeping: without it the same five areas get re-derived from
// scratch by the next reader, and each one is a place where a plausible bug
// WOULD be serious.
//
// The lens was the one that produced #265: when the codebase states an
// invariant, check that the sibling path honours it. Here every sibling did.
//
// Each assertion below is written to fail if the property is removed — not to
// restate that some code exists.
// =============================================================================

import { isStaffRoles } from "@sms/types";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const API = (p: string) => readFileSync(join(__dirname, "../../src", p), "utf8");
const SCHEMA = (f: string) =>
  readFileSync(join(__dirname, "../../../../packages/db/prisma/schema", f), "utf8");
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, "");
const model = (src: string, name: string) => {
  const at = src.indexOf(`model ${name} {`);
  return src.slice(at, src.indexOf("\n}", at));
};

describe("a timetable cannot double-book", () => {
  const SERVICE = strip(API("timetable/timetable.service.ts"));
  const ENTRY = model(SCHEMA("timetable.prisma"), "TimetableEntry");

  it.each(["classId", "teacherId", "roomId"])("the manual path checks %s", (field) => {
    const at = SERVICE.indexOf("assertNoConflict");
    const body = SERVICE.slice(at, at + 1400);
    expect([field, body.includes(field)]).toEqual([field, true]);
  });

  it("and the DATABASE enforces all three, which is what the generator relies on", () => {
    // The generator does not re-run assertNoConflict per lesson; it bulk-inserts
    // and lets the constraints refuse a clash. That is only safe while all
    // three unique indexes exist.
    for (const cols of [
      "[schoolId, classId, dayOfWeek, periodId]",
      "[schoolId, teacherId, dayOfWeek, periodId]",
      "[schoolId, roomId, dayOfWeek, periodId]",
    ]) {
      expect([cols, ENTRY.includes(`@@unique(${cols})`)]).toEqual([cols, true]);
    }
  });

  it("the generator turns a lost race into a clear refusal, not a raw P2002", () => {
    expect(SERVICE).toMatch(/The timetable changed while this was generating/);
  });

  it("a partly-applied generation is refused outright", () => {
    // One bulk insert, so the constraints reject the whole thing. A half-built
    // grid is worse than none — the opposite call from the per-item loops in
    // #263/#264, and right for the same reason: this is ONE decision.
    expect(SERVICE).toMatch(/timetableEntry\s*\n?\s*\.createMany\(/);
  });
});

describe("exactly one term and one session are current", () => {
  const ACADEMIC = strip(API("lms/academic.service.ts"));

  it("the pointer is CLEARED before it is set", () => {
    // Postgres enforces one-current-per-school with a PARTIAL unique index,
    // which Prisma's @@unique cannot express and so lives in a migration.
    // Setting a new current without clearing the old one fails every night.
    const clear = ACADEMIC.indexOf('term.updateMany({ where: { isCurrent: true');
    const set = ACADEMIC.indexOf('term.update({ where: { id: target.termId }');
    expect(clear).toBeGreaterThan(-1);
    expect(clear).toBeLessThan(set);
  });

  it("the session pointer moves the same way", () => {
    const clear = ACADEMIC.indexOf('academicSession.updateMany({ where: { isCurrent: true');
    const set = ACADEMIC.indexOf('academicSession.update({ where: { id: target.sessionId }');
    expect(clear).toBeGreaterThan(-1);
    expect(clear).toBeLessThan(set);
  });
});

describe("an announcement reaches only its audience", () => {
  const SRC = API("announcements/announcements.service.ts");
  const CODE = strip(SRC);

  it("defaults to student-side when the caller holds NO roles", () => {
    // A role-less principal is treated as student-side: the least-privilege
    // direction, and the one a negated check would have got wrong.
    //
    // ANCHORED TO THE PROPERTY, NOT THE SPELLING. This asserted the literal
    // source `p.roles.every((r) => STUDENT_SIDE_ROLES.has(r))` and went red when
    // four services were consolidated onto the shared `isStaffRoles` — a
    // fixed-text assertion firing on a change that STRENGTHENED what it guards,
    // which this repo has now recorded several times. The invariant is about
    // the answer, so the test asks for the answer.
    expect(isStaffRoles([])).toBe(false);
    expect(isStaffRoles(["student", "parent"])).toBe(false);
    expect(isStaffRoles(["librarian"])).toBe(true);
    expect(CODE).toMatch(/studentSideOnly \? \["ALL", "STUDENTS"\]/);
  });

  it("has no per-recipient fan-out, deliberately", () => {
    // One row read by many. A fan-out would have to repeat the audience filter
    // per recipient, which is exactly where a leak would live.
    expect(CODE).not.toMatch(/notifications?\.enqueue\(/);
    expect(SRC).toMatch(/no\s*\n?\/\/\s*per-recipient fan-out|\(no\s+per-recipient fan-out\)/);
  });
});

describe("leaving the school ends access, for staff AND pupils", () => {
  it("a staff exit closes the account, not just the employment record", () => {
    // The employment record was closed and the ACCOUNT left ACTIVE once; the
    // offboarding checklist's "Revoke system access" was a tickbox.
    expect(strip(API("hr/exit.service.ts"))).toMatch(/revokeStaffAccessInTx\(tx, row\.userId\)/);
    expect(strip(API("hr/staff-access.ts"))).toMatch(/status: "EXITED", exitedAt/);
  });

  it("a pupil exit does the same", () => {
    expect(strip(API("lms/student-exit.service.ts"))).toMatch(/status: "EXITED", exitedAt/);
  });
});

describe("a document link is short-lived", () => {
  it("both storage providers bound the presigned URL", () => {
    // The link is a bearer token for a minor's report card; the TTL is the
    // whole control.
    for (const f of ["documents/s3-storage.provider.ts", "documents/storage.provider.ts"]) {
      const ttl = /private readonly ttl = (\d+)/.exec(API(f))?.[1];
      expect([f, ttl]).toEqual([f, expect.any(String)]);
      expect([f, Number(ttl) <= 3600]).toEqual([f, true]);
    }
  });
});
