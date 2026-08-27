// =============================================================================
// The moment a quiz answer is revealed is the moment submissions must close
// =============================================================================
// `buildSessionView` reveals a question's `answerIndex` to PLAYERS once its
// clock has run out — deliberate, so the class can see what the answer was. But
// `answer` had no clock check at all, so the two boundaries were not the same
// boundary, and the gap between them was an exploit needing no tooling:
//
//   1. wait for the timer to expire
//   2. GET /quiz-sessions/:id — `answerIndex` is now in YOUR OWN payload
//   3. POST it back
//
// The engine zeroed the POINTS (`elapsedMs >= limitMs -> 0`), which made this
// look harmless. It was not: the row still recorded `correct: true` and the
// participant's tally still incremented, and `correct` is a PUBLIC leaderboard
// column shown by display name to the whole class.
//
// Measured live before the fix: a pupil who genuinely answered ONE of two
// questions was listed as `{"displayName":"Demo Student","score":798,
// "correct":2,"rank":1}`.
// =============================================================================

import { ConflictException } from "@nestjs/common";
import { QUIZ_DIFFICULTY_SPECS, scoreQuizAnswer } from "@sms/game-engine";
import { LiveQuizService } from "../../src/game/live-quiz.service";

const LIMIT_MS = QUIZ_DIFFICULTY_SPECS.MEDIUM.timeLimitSeconds * 1000;

/** The service's own clock, which both the reveal and the refusal now read. */
const clockOf = (startedAt: Date | null, difficulty: string) =>
  (LiveQuizService.prototype as unknown as {
    clockOf: (s: Date | null, d: string) => { elapsedMs: number; limitMs: number; closed: boolean };
  }).clockOf(startedAt, difficulty);

describe("an answer revealed is an answer closed", () => {
  it("treats the reveal boundary and the submission boundary as ONE instant", () => {
    const justInside = new Date(Date.now() - (LIMIT_MS - 1_000));
    const justPast = new Date(Date.now() - (LIMIT_MS + 1_000));

    expect(clockOf(justInside, "MEDIUM").closed).toBe(false);
    expect(clockOf(justPast, "MEDIUM").closed).toBe(true);
    // Any grace on one side would have to be a grace on the other, or the
    // window reopens. So the boundary is exactly the limit, both ways.
    expect(clockOf(new Date(Date.now() - LIMIT_MS), "MEDIUM").closed).toBe(true);
  });

  it("reads the limit from the question's own difficulty", () => {
    const at = new Date(Date.now() - 15_000);
    // 15s is past MEDIUM's 20s? No — inside it, but past HARD's 12s.
    expect(clockOf(at, "MEDIUM").closed).toBe(false);
    expect(clockOf(at, "HARD").closed).toBe(true);
    // An unrecognised difficulty falls back to MEDIUM rather than never closing.
    expect(clockOf(new Date(Date.now() - 25_000), "NONSENSE").closed).toBe(true);
  });

  it("refuses a submission once the clock has run out", async () => {
    const started = new Date(Date.now() - (LIMIT_MS + 5_000));
    const svc = quizServiceWith(started);
    await expect(
      svc.answer({ userId: "pupil", schoolId: "s" } as never, "sess", 1),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it("still accepts an answer inside the clock, and scores it", async () => {
    const started = new Date(Date.now() - 2_000);
    const svc = quizServiceWith(started);
    const out = await svc.answer({ userId: "pupil", schoolId: "s" } as never, "sess", 1);
    expect(out.correct).toBe(true);
    expect(out.points).toBeGreaterThan(0);
  });

  it("the engine zeroing points was never enough on its own", () => {
    // The reason this looked harmless. Points go to zero at the limit — and the
    // service went on recording `correct: true` beside them.
    const late = scoreQuizAnswer({
      correct: true,
      elapsedMs: LIMIT_MS + 1,
      priorStreak: 3,
      difficulty: "MEDIUM",
    });
    expect(late).toEqual({ points: 0, newStreak: 0 });
  });
});

/** The real service over a stubbed tenant transaction. */
function quizServiceWith(questionStartedAt: Date): LiveQuizService {
  const participant = { id: "part-1", score: 0, streak: 0, correct: 0 };
  const tx = {
    liveQuizSession: {
      findFirst: async () => ({
        id: "sess",
        quizId: "q1",
        status: "ACTIVE",
        currentIndex: 0,
        questionStartedAt,
      }),
    },
    liveQuizParticipant: {
      findFirst: async () => participant,
      update: async () => ({ ...participant, score: 700, streak: 1, correct: 1 }),
    },
    liveQuizQuestion: {
      findFirst: async () => ({ orderIndex: 0, answerIndex: 1, choices: ["a", "b", "c"] }),
    },
    liveQuizAnswer: { findFirst: async () => null, create: async () => ({}) },
    liveQuiz: { findFirst: async () => ({ difficulty: "MEDIUM" }) },
  };
  const svc = Object.create(LiveQuizService.prototype) as LiveQuizService;
  Object.assign(svc, {
    db: { runAsTenant: async (_c: unknown, fn: (t: unknown) => unknown) => fn(tx) },
    audit: { record: async () => undefined },
    events: { emitChanged: () => undefined },
  });
  return svc;
}
