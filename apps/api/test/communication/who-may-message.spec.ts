// =============================================================================
// A teacher could not write to a parent
// =============================================================================
// Messaging is described as two-way, and the parent help says "write to your
// child's teachers; replies appear in the same thread". Replies did. Nothing
// else did — the rule "staff may write to anyone, everyone else only to
// staff/teachers" was implemented with
//
//   const STAFF = new Set(["school_admin", "principal"]);
//
// so a TEACHER was not staff. A teacher could not open a thread with a pupil
// they teach, or with that pupil's parent. Neither could the bursar chasing an
// unpaid fee, nor the librarian chasing a book. Only the principal and the
// school admin could reach a family at all.
//
// Families could always write TO teachers, so the module worked in exactly one
// direction: a teacher could answer a parent but never raise anything with them
// — a mark slipping, a child upset, a missed week. That is the wrong half of a
// parent-teacher relationship to support.
//
// It was not a deliberate policy. The documented rule is "non-staff may only
// message staff/teachers", and a teacher is staff by any ordinary reading; the
// two-role set simply did not say what the rule said.
//
// The replacement is the platform's model everywhere else — coarse role, then a
// relationship narrows the rows — and the narrowing is doing real work here:
// a teacher reaches THEIR pupils, not every child in the school. An adult
// opening a private channel to a minor they have no connection to is precisely
// what relationship scoping exists to prevent (Golden Rule #5).
// =============================================================================

import { readFileSync } from "node:fs";
import { join } from "node:path";

const SRC = readFileSync(join(__dirname, "../../src/communication/messaging.service.ts"), "utf8");

describe("the sender tiers", () => {
  it("no longer decides 'staff' from a two-role set", () => {
    expect(SRC).not.toMatch(/const STAFF = new Set\(\["school_admin", "principal"\]\)/);
  });

  it("school-wide senders reach anyone; that stays the narrow set", () => {
    expect(SRC).toMatch(/const SCHOOL_WIDE_SENDERS = new Set\(\["school_admin", "principal"\]\)/);
  });

  it("a teacher's reach comes from the classes they teach", () => {
    expect(SRC).toMatch(/const CLASS_SCOPED_SENDERS = new Set\(\["teacher", "head_teacher"\]\)/);
  });

  it("finance reaches guardians — adults — and never pupils", () => {
    expect(SRC).toMatch(/const GUARDIAN_WIDE_SENDERS = new Set\(\["accountant"\]\)/);
    // The finance branch adds guardians only. If a pupil clause ever appears
    // beside it, someone has given the bursar a private line to children.
    const financeBranch = SRC.slice(
      SRC.indexOf("GUARDIAN_WIDE_SENDERS.has(r)"),
      SRC.indexOf("CLASS_SCOPED_SENDERS.has(r)"),
    );
    expect(financeBranch).toMatch(/parentLinks: \{ some: \{\} \}/);
    expect(financeBranch).not.toMatch(/roles.*student/);
  });
});

describe("the picker and the guard cannot disagree", () => {
  // The recurring defect in this codebase is a rule expressed twice. Here it
  // would mean a compose box that lists someone the send then refuses, or hides
  // someone the send would have allowed.
  it("both go through one definition", () => {
    expect(SRC).toMatch(/private async recipientScope\(/);
    const calls = SRC.match(/this\.recipientScope\(tx, p\)/g) ?? [];
    expect(calls).toHaveLength(2); // contacts() and assertCanMessage()
  });

  it("the guard asks the SAME clause about one person", () => {
    expect(SRC).toMatch(/where: \{ id: recipientId, \.\.\.scope \}/);
  });

  it("the picker filters by it in SQL rather than in memory", () => {
    // It already did this for the roll-size reason; it must keep doing it.
    expect(SRC).toMatch(/\.\.\.\(scope \?\? \{\}\)/);
  });
});

describe("what the teacher's set contains", () => {
  const scope = SRC.slice(SRC.indexOf("private async recipientScope("), SRC.indexOf("/** The caller's threads"));

  it("is built from taught, supervised AND subject-taught classes", () => {
    // Missing any one of the three silently drops a teacher's own pupils: a
    // subject teacher who is nobody's form tutor would have had an empty set.
    expect(scope).toMatch(/tx\.classTeacher\.findMany/);
    expect(scope).toMatch(/supervisorId: p\.userId/);
    expect(scope).toMatch(/tx\.classSubjectTeacher\.findMany/);
  });

  it("counts only ACTIVE enrolments", () => {
    // A pupil who has left is no longer theirs to write to — the same rule the
    // roll, the register and the billing seat count all now use.
    expect(scope).toMatch(/status: "ACTIVE"/);
  });

  it("includes those pupils' guardians", () => {
    expect(scope).toMatch(/parentLinks: \{ some: \{ studentId: \{ in: studentIds \} \} \}/);
  });

  it("does NOT fall back to every pupil when a teacher has no classes", () => {
    // The dangerous failure: an empty relationship set widening to "anyone"
    // rather than "nobody extra". The pupil clauses are pushed only inside the
    // `if (studentIds.length)` guard, so no classes means no pupils.
    expect(scope).toMatch(/if \(studentIds\.length\) \{/);
  });
});

describe("the refusal says which rule was missed", () => {
  it("no longer tells a teacher they may only message staff and teachers", () => {
    // That sentence was shown to a teacher writing to their own pupil, and named
    // a reason that was not the reason.
    expect(SRC).toMatch(/You can message staff, the pupils you teach, and their parents/);
    expect(SRC).toMatch(/ask the school office to pass it on/);
  });
});
