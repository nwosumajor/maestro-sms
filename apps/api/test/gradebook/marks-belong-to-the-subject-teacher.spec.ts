/**
 * A SUBJECT TEACHER OWNS THEIR SUBJECT'S MARKS; THE CLASS TEACHER DOES NOT.
 *
 * The two roles are deliberately different. SS1A has ONE class teacher — the
 * same person as the form teacher and the class supervisor — who monitors the
 * class and takes its register. It also offers eleven subjects taught by eleven
 * different people, each of whom prepares that subject's syllabus, assignments
 * and exams, and each of whom owns its marks.
 *
 * So the grading gate is the EXACT offering — this class AND this subject —
 * never "do I teach here at all". Being the class teacher is not a licence to
 * enter marks for somebody else's subject, and teaching Maths in SS1A is not a
 * licence to enter its English marks.
 *
 * Verified live before this was written: a subject teacher got 200 on the
 * roster and 201 on a mark for their own subject, and 404 on both for a subject
 * they do not teach.
 *
 * The attendance half of the pair is pinned separately — a subject teacher of a
 * class cannot take its register, only its class teacher can.
 */
import { TermResultService } from "../../src/gradebook/term-result.service";
import type { Principal, TenantContext, TenantTx } from "../../src/integrity/integrity.foundation";

const CLASS = "c1";
const MINE = "maths";
const THEIRS = "english";

const teacher = (id: string): Principal =>
  ({ schoolId: "A", userId: id, roles: ["teacher"], permissions: ["grade.write"] }) as Principal;
const head: Principal =
  ({ schoolId: "A", userId: "sa", roles: ["school_admin"], permissions: ["grade.write"] }) as Principal;

/** `offerings` are the (subject, teacher) pairs this class actually runs. */
function harness(offerings: Array<{ subjectId: string; teacherId: string }>) {
  const tx = {
    term: { findFirst: jest.fn().mockResolvedValue({ id: "t1", sessionId: "s1" }) },
    subject: { findFirst: jest.fn().mockResolvedValue({ id: MINE, name: "Maths" }) },
    // HONOURS THE WHERE. The gate asks for one exact offering, so a stub that
    // answered every question with a row would pass every case here.
    classSubjectTeacher: {
      findFirst: jest.fn(({ where }: { where: { classId: string; subjectId: string; teacherId: string } }) =>
        Promise.resolve(
          offerings.find((o) => o.subjectId === where.subjectId && o.teacherId === where.teacherId) &&
            where.classId === CLASS
            ? { id: "o1" }
            : null,
        ),
      ),
      findMany: jest.fn().mockResolvedValue([]),
    },
    class: { findMany: jest.fn().mockResolvedValue([]) },
    enrollment: { findFirst: jest.fn().mockResolvedValue({ id: "e1" }) },
  } as unknown as TenantTx;
  const db = {
    runAsTenant: <T>(_c: TenantContext, fn: (t: TenantTx) => Promise<T>) => fn(tx),
    runAsTenantReadOnly: <T>(_c: TenantContext, fn: (t: TenantTx) => Promise<T>) => fn(tx),
  };
  const svc = Object.create(TermResultService.prototype) as TermResultService;
  Object.assign(svc, { db });
  return { svc, tx };
}

/** The gate itself, which every marks path goes through. */
const mayGrade = (svc: TermResultService, tx: TenantTx, p: Principal, subjectId: string) =>
  (svc as unknown as {
    canGradeClassSubject: (t: TenantTx, p: Principal, c: string, s: string) => Promise<boolean>;
  }).canGradeClassSubject(tx, p, CLASS, subjectId);

describe("marks belong to the subject teacher", () => {
  const OFFERINGS = [
    { subjectId: MINE, teacherId: "maths-teacher" },
    { subjectId: THEIRS, teacherId: "english-teacher" },
  ];

  it("the subject teacher may grade the subject they teach in that class", async () => {
    const { svc, tx } = harness(OFFERINGS);
    await expect(mayGrade(svc, tx, teacher("maths-teacher"), MINE)).resolves.toBe(true);
  });

  it("…and NOT another subject in the same class", async () => {
    // Eleven subjects, eleven teachers: one of them entering another's marks is
    // the thing this gate exists to stop.
    const { svc, tx } = harness(OFFERINGS);
    await expect(mayGrade(svc, tx, teacher("maths-teacher"), THEIRS)).resolves.toBe(false);
  });

  it("the CLASS TEACHER may not grade a subject they do not teach", async () => {
    // They run the class and take its register; the marks are the subject
    // teacher's. Being responsible for a class is not a licence to enter marks
    // in somebody else's subject.
    const { svc, tx } = harness(OFFERINGS);
    await expect(mayGrade(svc, tx, teacher("the-class-teacher"), MINE)).resolves.toBe(false);
  });

  it("school-wide staff may, because somebody has to be able to fix a mark", async () => {
    const { svc, tx } = harness(OFFERINGS);
    await expect(mayGrade(svc, tx, head, THEIRS)).resolves.toBe(true);
  });

  it("the gate asks for the EXACT offering, not merely a teaching relationship", async () => {
    // The consolidation of "do I teach this child" deliberately did NOT reach
    // here: that union answers read scope, and grading is narrower.
    const { svc, tx } = harness(OFFERINGS);
    await mayGrade(svc, tx, teacher("maths-teacher"), MINE);
    const where = (tx.classSubjectTeacher.findFirst as jest.Mock).mock.calls[0][0].where;
    expect(where).toMatchObject({ classId: CLASS, subjectId: MINE, teacherId: "maths-teacher" });
  });
});
