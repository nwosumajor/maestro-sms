// =============================================================================
// A quiz attempt cap that was a COUNT followed by an INSERT
// =============================================================================
// `attemptQuiz` reads `count(attempts)`, compares it to `maxAttempts`, and then
// inserts. Nothing sits between them. At READ COMMITTED — this codebase sets no
// isolation level — two attempts submitted together both count the same number,
// both pass the cap, and both insert.
//
// Proven by interleaving the service's own statements in two psql sessions on a
// 5,000-school fleet: both counted 0, both inserted, and the pupil finished with
// TWO attempts on a ONE-attempt quiz, both numbered 1 — so the cap was evaded
// AND the attempt history showed "attempt 1" twice to whoever marked it.
//
// Eight concurrent HTTP attempts did NOT reproduce it; the window is narrow.
// That is a reason to close it cheaply, not a reason to call it safe — the same
// conclusion the library return reached about the same shape.
//
// The rule is expressible as a constraint, so it is one:
// `@@unique([contentId, studentId, attemptNo])`. The loser is told exactly what
// the cap guard says, because a guard and the race behind it must answer with
// the SAME status or the race becomes observable. Verified live: the guard path
// and the race path both give 409 "You have no attempts left for this quiz".
// =============================================================================

import { ConflictException } from "@nestjs/common";
import { Prisma } from "@sms/db";
import { LmsContentService } from "../../src/lms/lms-content.service";
import type { Principal, TenantContext, TenantTx } from "../../src/integrity/integrity.foundation";

const student: Principal = { schoolId: "A", userId: "stu-1", roles: ["student"], permissions: [] };

const QUIZ_BODY = {
  kind: "QUIZ",
  quiz: {
    questions: [{ id: "q1", type: "MCQ", prompt: "?", options: ["a", "b"], points: 1, answer: "a" }],
  },
};

function harness(opts: { attemptsAlready: number; createThrows?: boolean }) {
  const created: Array<Record<string, unknown>> = [];
  const tx = {
    lmsContent: {
      findFirst: jest.fn(async () => ({
        id: "c-1", schoolId: "A", classId: "cls-1", type: "QUIZ", status: "PUBLISHED",
        title: "Q", body: QUIZ_BODY, authorId: "t-1",
      })),
    },
    enrollment: { findFirst: jest.fn(async () => ({ id: "e1", status: "ACTIVE" })) },
    parentChild: { findFirst: jest.fn(async () => null) },
    quizAttempt: {
      count: jest.fn(async () => opts.attemptsAlready),
      create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => {
        if (opts.createThrows) {
          // What Postgres raises when the OTHER racer inserted first.
          throw new Prisma.PrismaClientKnownRequestError("Unique constraint failed", {
            code: "P2002", clientVersion: "5.22.0",
          });
        }
        created.push(data);
        return { id: "a-1", ...data };
      }),
      findMany: jest.fn(async () => []),
    },
    xapiStatement: { create: jest.fn(async () => ({})) },
    user: { findFirst: jest.fn(async () => ({ id: "stu-1", name: "A Pupil" })), findMany: jest.fn(async () => []) },
  } as unknown as TenantTx;

  const db = {
    runAsTenant: <T>(_c: TenantContext, fn: (t: TenantTx) => Promise<T>) => fn(tx),
    runAsTenantReadOnly: <T>(_c: TenantContext, fn: (t: TenantTx) => Promise<T>) => fn(tx),
  };
  // Constructor order: db, audit, workflow, notifications, storage, termResults.
  // A double must satisfy the real signature, not merely fill the arity.
  const svc = new LmsContentService(
    db as never,
    { record: jest.fn() } as never,
    { create: jest.fn(), transition: jest.fn() } as never,
    { enqueue: jest.fn(), enqueueMany: jest.fn() } as never,
    { presignUpload: jest.fn(), presignDownload: jest.fn() } as never,
    { applyLmsGrades: jest.fn() } as never,
  );
  return { svc, tx, created };
}

describe("the attempt cap", () => {
  it("lets a first attempt through", async () => {
    const { svc, created } = harness({ attemptsAlready: 0 });
    await svc.attemptQuiz(student, "c-1", { q1: "a" });
    expect(created).toHaveLength(1);
    expect(created[0].attemptNo).toBe(1);
  });

  it("refuses a second when the count already shows one — the readable guard", async () => {
    const { svc } = harness({ attemptsAlready: 1 });
    await expect(svc.attemptQuiz(student, "c-1", { q1: "a" })).rejects.toBeInstanceOf(ConflictException);
  });

  it("refuses the RACER too, when the constraint catches what the count could not", async () => {
    // Both racers counted 0 and both passed the guard; the database rejects the
    // second. Without this catch the pupil saw a 500 and the platform had no
    // idea whether the attempt counted.
    const { svc } = harness({ attemptsAlready: 0, createThrows: true });
    await expect(svc.attemptQuiz(student, "c-1", { q1: "a" })).rejects.toBeInstanceOf(ConflictException);
  });

  it("tells the racer the SAME thing as the guard — the race must not be observable", async () => {
    const guard = harness({ attemptsAlready: 1 });
    const racer = harness({ attemptsAlready: 0, createThrows: true });
    const said = async (h: ReturnType<typeof harness>) => {
      try { await h.svc.attemptQuiz(student, "c-1", { q1: "a" }); return "no error"; }
      catch (e) { return (e as Error).message; }
    };
    expect(await said(racer)).toBe(await said(guard));
  });

  it("does not swallow a DIFFERENT database error as 'no attempts left'", async () => {
    // A blanket catch would report a connection fault as a spent attempt, and
    // the pupil would stop trying.
    const { svc, tx } = harness({ attemptsAlready: 0 });
    (tx.quizAttempt.create as jest.Mock).mockRejectedValueOnce(new Error("connection reset"));
    await expect(svc.attemptQuiz(student, "c-1", { q1: "a" })).rejects.toThrow(/connection reset/);
  });
});
