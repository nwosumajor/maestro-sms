// =============================================================================
// Per-subject class rank on a pupil's report card
// =============================================================================
// The rank was already computed — on the TEACHER's subject scoresheet. A pupil's
// card showed their score in each subject and their overall position, but never
// their position IN that subject, which is the number a family actually asks
// about ("she's doing well overall, but how is she doing in Maths?").
//
// Three properties carry the weight, and each is a way this goes wrong quietly:
//
//   • ranked over PUBLISHED marks ONLY, whatever the viewer may see — otherwise
//     a teacher's copy and the family's disagree, and a pupil's rank moves every
//     time an unrelated mark is published
//   • standard competition ranking: ties SHARE a position and the next skips
//   • an ungraded pupil is UNRANKED, never last

import { TermResultService } from "../../src/gradebook/term-result.service";
import type { Principal, TenantContext, TenantTx } from "../../src/integrity/integrity.foundation";

const staff: Principal = { schoolId: "A", userId: "t1", roles: ["school_admin"], permissions: ["grade.read"] };
const SESSION = "sess-1";
const TERM = "term-1";
const SUBJ = "sub-maths";

type Row = { studentId: string; subjectId: string; termId: string; sessionId: string; status: string; exam: number | null; midterm: number | null; assignment: number | null; classNote: number | null };
// NOTE: exam is out of 60 and computeTermSubjectGrade CLAMPS anything above it,
// so fixtures must stay in range — 90/80/70 all collapse to 60 and every pupil
// ties at 1st, which is how the first version of this suite "found" a bug that
// was in its own data.
const row = (studentId: string, exam: number | null, status = "PUBLISHED"): Row => ({
  studentId, subjectId: SUBJ, termId: TERM, sessionId: SESSION, status,
  exam,
  // UNGRADED means every component is null. Leaving zeros in the other three
  // makes the pupil marked-with-zero, which is a different thing and ranks
  // last rather than unranked — the distinction this suite is testing.
  ...(exam === null
    ? { midterm: null, assignment: null, classNote: null }
    : { midterm: 0, assignment: 0, classNote: 0 }),
});

function svc(peers: Row[], me: string) {
  const tx = {
    academicSession: { findFirst: jest.fn().mockResolvedValue({ id: SESSION, name: "2026/2027" }) },
    user: { findFirst: jest.fn().mockResolvedValue({ id: me, name: "Pupil" }) },
    parentChild: { findFirst: jest.fn().mockResolvedValue(null) },
    term: { findMany: jest.fn().mockResolvedValue([{ id: TERM, name: "First Term", sequence: 1 }]) },
    subject: { findMany: jest.fn().mockResolvedValue([{ id: SUBJ, name: "Mathematics" }]) },
    class: { findFirst: jest.fn().mockResolvedValue({ name: "JSS1" }) },
    enrollment: {
      findFirst: jest.fn().mockResolvedValue({ classId: "c1" }),
      findMany: jest.fn().mockResolvedValue([...new Set(peers.map((p) => p.studentId))].map((studentId) => ({ studentId }))),
    },
    subjectResult: {
      findMany: jest.fn(({ where }: { where: Record<string, unknown> }) =>
        Promise.resolve(
          where.studentId && typeof where.studentId === "string"
            ? peers.filter((r) => r.studentId === where.studentId)
            : peers.filter((r) => !where.status || r.status === where.status),
        ),
      ),
    },
    classTeacher: { findFirst: jest.fn().mockResolvedValue(null) },
    classSubjectTeacher: { findFirst: jest.fn().mockResolvedValue(null) },
  } as unknown as TenantTx;
  const db = {
    runAsTenant: <T>(_c: TenantContext, fn: (t: TenantTx) => Promise<T>) => fn(tx),
    runAsTenantReadOnly: <T>(_c: TenantContext, fn: (t: TenantTx) => Promise<T>) => fn(tx),
  };
  const stub = { record: jest.fn().mockResolvedValue(undefined) };
  // The service registers a GRADE_PUBLISH reactor on construction.
  const hooks = { onFinalized: jest.fn() };
  const academic = {
    academicInTx: async () => ({ calendarTemplate: "THREE_TERM", grading: null }),
    academicForSchool: async () => ({ calendarTemplate: "THREE_TERM", grading: null }),
  };
  return new TermResultService(db as never, stub as never, stub as never, hooks as never, academic as never);
}

const rankOf = async (peers: Row[], me: string) => {
  const out = await svc(peers, me).getStudentSessionReport(staff, { studentId: me, sessionId: SESSION });
  const r = out.terms[0].subjects.find((x) => x.subjectId === SUBJ);
  return { position: r?.subjectPosition ?? null, ranked: r?.subjectRanked ?? null };
};

describe("per-subject rank", () => {
  it("ranks a pupil against their classmates in that subject", async () => {
    const peers = [row("a", 55), row("b", 45), row("me", 35)];
    expect(await rankOf(peers, "me")).toEqual({ position: 3, ranked: 3 });
  });

  it("puts the top scorer first", async () => {
    expect(await rankOf([row("me", 58), row("b", 40)], "me")).toEqual({ position: 1, ranked: 2 });
  });

  it("SHARES a position on a tie, and skips the next rank", async () => {
    // 68, 68, 65 -> 1st, 1st, 3rd. Telling two pupils on the same mark they are
    // 1st and 2nd is what makes a parent write in.
    const peers = [row("a", 48), row("me", 48), row("c", 40)];
    expect(await rankOf(peers, "me")).toEqual({ position: 1, ranked: 3 });
    const third = await rankOf(peers, "c");
    expect(third.position).toBe(3);
  });

  it("leaves an UNGRADED pupil unranked rather than last", async () => {
    // Last place implies they were beaten. They simply were not marked.
    const peers = [row("a", 55), row("b", 45), row("me", null)];
    expect(await rankOf(peers, "me")).toEqual({ position: null, ranked: null });
  });

  it("excludes ungraded classmates from the DENOMINATOR", async () => {
    // "2 of 3" when only two were marked overstates what the pupil beat.
    const peers = [row("a", 55), row("me", 45), row("c", null)];
    expect(await rankOf(peers, "me")).toEqual({ position: 2, ranked: 2 });
  });

  it("ranks over PUBLISHED marks only, so every viewer sees the same number", async () => {
    // A DRAFT 99 must not push this pupil down: the family cannot see it, and a
    // position that differs between the teacher's copy and the parent's is a
    // support call.
    const peers = [row("a", 59, "DRAFT"), row("me", 45), row("c", 35)];
    expect(await rankOf(peers, "me")).toEqual({ position: 1, ranked: 2 });
  });

  it("is null when nobody in the class has a published mark", async () => {
    expect(await rankOf([row("me", null)], "me")).toEqual({ position: null, ranked: null });
  });
});
