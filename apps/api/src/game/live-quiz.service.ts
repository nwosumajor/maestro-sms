// =============================================================================
// LiveQuizService — Kahoot-style, curriculum-themed live quiz (SMS integration)
// =============================================================================
// A teacher AUTHORS a themed quiz and HOSTS a live session for a class; enrolled
// students join and answer against a server clock, scoring more for correct AND
// fast answers (pure scoring in @sms/game-engine `quiz.ts`). Reuses the standard
// built-module security posture:
//   - Tenant isolation: schoolId from the JWT on every row; RLS backstops.
//   - Relationship scoping: host = teacher of the class (or school-wide staff);
//     players = ENROLLED students; a viewer only sees sessions they host/teach/
//     are enrolled in/joined. 404-not-403 cross-tenant & cross-relationship.
//   - Server authority (spec §9): the correct answerIndex is NEVER serialized to
//     a student while a question is live — revealed only once the question's
//     time limit has elapsed or the session has ENDED. Timing is measured from
//     the server-stamped questionStartedAt; scoring is computed here.
//   - Every mutation is audit-logged (Golden Rule #5 — minors' game telemetry).
//   - No automated consequence (Golden Rule #8): a quiz produces scores/fun, not
//     a grade or record entry.
// =============================================================================

import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import {
  QUIZ_DIFFICULTY_SPECS,
  isGameDifficulty,
  isQuizTheme,
  isValidQuizQuestion,
  rankQuizStandings,
  scoreQuizAnswer,
  type GameDifficulty,
  type QuizQuestion,
  type QuizStanding,
} from "@sms/game-engine";
import { Prisma } from "@sms/db";
import type {
  LiveQuizAnswerResultDto,
  LiveQuizDto,
  LiveQuizSessionDto,
  LiveQuizSessionSummaryDto,
  LiveQuizSummaryDto,
  QuizDifficultyDto,
  QuizThemeDto,
} from "@sms/types";
import {
  AUDIT_LOG_SERVICE,
  TENANT_DATABASE,
  type AuditLogService,
  type Principal,
  type TenantContext,
  type TenantDatabase,
  type TenantTx,
} from "../integrity/integrity.foundation";
import { effectiveGameSettings } from "./game-settings.util";
import { GameEventsService } from "./game-events.service";

const SCHOOL_WIDE_ROLES = new Set(["school_admin", "principal", "super_admin"]);
/** How many leaderboard rows the live view returns. */
const LEADERBOARD_SIZE = 20;

interface QuestionInput {
  prompt: string;
  choices: string[];
  answerIndex: number;
}

@Injectable()
export class LiveQuizService {
  constructor(
    @Inject(TENANT_DATABASE) private readonly db: TenantDatabase,
    @Inject(AUDIT_LOG_SERVICE) private readonly audit: AuditLogService,
    private readonly events: GameEventsService,
  ) {}

  private ctx(p: Principal): TenantContext {
    return { schoolId: p.schoolId, userId: p.userId };
  }
  private isSchoolWide(p: Principal): boolean {
    return p.roles.some((r) => SCHOOL_WIDE_ROLES.has(r));
  }

  /** Run a mutation, then announce the changed session AFTER the tx commits. */
  private async withEmit<T extends { id?: string }>(
    p: Principal,
    id: string | null,
    fn: (tx: TenantTx) => Promise<T>,
  ): Promise<T> {
    const out = await this.db.runAsTenant(this.ctx(p), fn);
    const sessionId = id ?? out.id ?? null;
    if (sessionId) this.events.emitChanged(sessionId);
    return out;
  }

  // --- quiz authoring -----------------------------------------------------
  /** Author a themed quiz + its questions (host/staff). */
  async createQuiz(
    p: Principal,
    input: { title: string; theme: string; difficulty: string; questions: QuestionInput[] },
  ): Promise<LiveQuizDto> {
    const title = (input.title ?? "").trim();
    if (!title) throw new BadRequestException("title is required");
    if (!isQuizTheme(input.theme)) throw new BadRequestException("invalid theme");
    if (!isGameDifficulty(input.difficulty)) throw new BadRequestException("invalid difficulty");
    const questions = input.questions ?? [];
    if (questions.length < 1) throw new BadRequestException("at least one question is required");
    // Validate every question via the engine (2–6 choices, one valid answer).
    questions.forEach((q, i) => {
      const candidate: QuizQuestion = {
        id: String(i),
        prompt: q.prompt,
        choices: q.choices,
        answerIndex: q.answerIndex,
        theme: input.theme as QuizThemeDto,
        difficulty: input.difficulty as GameDifficulty,
      };
      if (!isValidQuizQuestion(candidate)) {
        throw new BadRequestException(`question ${i + 1} is invalid (2–6 non-empty choices, one valid answer)`);
      }
    });

    return this.db.runAsTenant(this.ctx(p), async (tx) => {
      await this.assertGamesEnabled(tx, p.schoolId);
      const quiz = await tx.liveQuiz.create({
        data: {
          schoolId: p.schoolId,
          title,
          theme: input.theme,
          difficulty: input.difficulty,
          createdById: p.userId,
        },
      });
      await tx.liveQuizQuestion.createMany({
        data: questions.map((q, i) => ({
          schoolId: p.schoolId,
          quizId: quiz.id,
          orderIndex: i,
          prompt: q.prompt.trim(),
          choices: q.choices as unknown as Prisma.InputJsonValue,
          answerIndex: q.answerIndex,
        })),
      });
      await this.log(tx, p, "quiz.create", quiz.id, { theme: input.theme, questions: questions.length });
      return this.buildQuizView(tx, quiz.id);
    });
  }

  /** The caller's school quiz library (staff pick when hosting). */
  async listQuizzes(p: Principal): Promise<LiveQuizSummaryDto[]> {
    return this.db.runAsTenant(this.ctx(p), async (tx) => {
      const quizzes = await tx.liveQuiz.findMany({ orderBy: { createdAt: "desc" }, take: 100 });
      if (quizzes.length === 0) return [];
      const counts = await tx.liveQuizQuestion.groupBy({
        by: ["quizId"],
        where: { quizId: { in: quizzes.map((q) => q.id) } },
        _count: { _all: true },
      });
      const byQuiz = new Map(counts.map((c) => [c.quizId, c._count._all]));
      return quizzes.map((q) => ({
        id: q.id,
        title: q.title,
        theme: q.theme as QuizThemeDto,
        difficulty: q.difficulty as QuizDifficultyDto,
        questionCount: byQuiz.get(q.id) ?? 0,
        createdAt: q.createdAt,
      }));
    });
  }

  async getQuiz(p: Principal, quizId: string): Promise<LiveQuizDto> {
    return this.db.runAsTenant(this.ctx(p), (tx) => this.buildQuizView(tx, quizId));
  }

  // --- session lifecycle --------------------------------------------------
  /** Host opens a session of a quiz for a class (LOBBY). */
  async openSession(p: Principal, input: { quizId: string; classId: string }): Promise<LiveQuizSessionDto> {
    return this.withEmit(p, null, async (tx) => {
      await this.assertGamesEnabled(tx, p.schoolId);
      const quiz = await tx.liveQuiz.findFirst({ where: { id: input.quizId } });
      if (!quiz) throw new NotFoundException("Quiz not found");
      await this.assertTeacherOfClass(tx, p, input.classId);
      const session = await tx.liveQuizSession.create({
        data: {
          schoolId: p.schoolId,
          quizId: quiz.id,
          classId: input.classId,
          hostId: p.userId,
          status: "LOBBY",
        },
      });
      await this.log(tx, p, "quiz.session.open", session.id, { quizId: quiz.id, classId: input.classId });
      return this.buildSessionView(tx, session.id, p);
    });
  }

  /** An enrolled student joins a session lobby (or an already-running session). */
  async joinSession(p: Principal, sessionId: string): Promise<LiveQuizSessionDto> {
    return this.withEmit(p, sessionId, async (tx) => {
      const session = await this.requireSession(tx, sessionId);
      if (session.status === "ENDED") throw new ConflictException("Session has ended");
      await this.assertEnrolled(tx, p, session.classId);
      const existing = await tx.liveQuizParticipant.findFirst({ where: { sessionId, userId: p.userId } });
      if (!existing) {
        await tx.liveQuizParticipant.create({
          data: { schoolId: p.schoolId, sessionId, userId: p.userId },
        });
        await this.log(tx, p, "quiz.session.join", sessionId);
      }
      return this.buildSessionView(tx, sessionId, p);
    });
  }

  /**
   * Host advances to the next question (or starts the first). Stamps
   * questionStartedAt server-side so answer timing is authoritative. Advancing
   * past the last question ENDS the session.
   */
  async nextQuestion(p: Principal, sessionId: string): Promise<LiveQuizSessionDto> {
    return this.withEmit(p, sessionId, async (tx) => {
      const session = await this.requireSession(tx, sessionId);
      await this.assertHost(tx, p, session);
      if (session.status === "ENDED") throw new ConflictException("Session has ended");
      const total = await tx.liveQuizQuestion.count({ where: { quizId: session.quizId } });
      const nextIndex = session.currentIndex + 1;
      if (nextIndex >= total) {
        await tx.liveQuizSession.update({
          where: { id: sessionId },
          data: { status: "ENDED", endedAt: new Date(), questionStartedAt: null },
        });
        await this.log(tx, p, "quiz.session.end", sessionId, { reason: "completed" });
        return this.buildSessionView(tx, sessionId, p);
      }
      await tx.liveQuizSession.update({
        where: { id: sessionId },
        data: {
          status: "ACTIVE",
          currentIndex: nextIndex,
          questionStartedAt: new Date(),
          startedAt: session.startedAt ?? new Date(),
        },
      });
      await this.log(tx, p, "quiz.session.next", sessionId, { index: nextIndex });
      return this.buildSessionView(tx, sessionId, p);
    });
  }

  /**
   * Submit an answer to the CURRENT question. Server-authoritative: computes
   * elapsed from questionStartedAt, scores via the engine, records an append-only
   * answer (unique per question → no double-answer), and updates the running
   * score/streak. Returns ONLY the caller's own result.
   */
  async answer(p: Principal, sessionId: string, choiceIndex: number): Promise<LiveQuizAnswerResultDto> {
    const result = await this.db.runAsTenant(this.ctx(p), async (tx) => {
      const session = await this.requireSession(tx, sessionId);
      if (session.status !== "ACTIVE" || session.currentIndex < 0 || !session.questionStartedAt) {
        throw new ConflictException("No question is currently live");
      }
      const me = await tx.liveQuizParticipant.findFirst({ where: { sessionId, userId: p.userId } });
      if (!me) throw new NotFoundException("Session not found"); // relationship scope
      const question = await tx.liveQuizQuestion.findFirst({
        where: { quizId: session.quizId, orderIndex: session.currentIndex },
      });
      if (!question) throw new ConflictException("No question is currently live");
      const choices = question.choices as unknown as string[];
      if (!Number.isInteger(choiceIndex) || choiceIndex < 0 || choiceIndex >= choices.length) {
        throw new BadRequestException("choiceIndex out of range");
      }
      // One answer per question (unique constraint also backstops races).
      const already = await tx.liveQuizAnswer.findFirst({
        where: { sessionId, participantId: me.id, questionIndex: session.currentIndex },
      });
      if (already) throw new ConflictException("You have already answered this question");

      const quiz = await tx.liveQuiz.findFirst({ where: { id: session.quizId }, select: { difficulty: true } });
      const diff = (quiz?.difficulty ?? "MEDIUM") as GameDifficulty;
      const elapsedMs = Math.max(0, Date.now() - session.questionStartedAt.getTime());
      const correct = choiceIndex === question.answerIndex;
      const { points, newStreak } = scoreQuizAnswer({
        correct,
        elapsedMs,
        priorStreak: me.streak,
        difficulty: isGameDifficulty(diff) ? diff : "MEDIUM",
      });

      await tx.liveQuizAnswer.create({
        data: {
          schoolId: p.schoolId,
          sessionId,
          participantId: me.id,
          questionIndex: session.currentIndex,
          choiceIndex,
          correct,
          elapsedMs,
          points,
        },
      });
      const updated = await tx.liveQuizParticipant.update({
        where: { id: me.id },
        data: { score: me.score + points, streak: newStreak, correct: me.correct + (correct ? 1 : 0) },
      });
      await this.log(tx, p, "quiz.answer", sessionId, { index: session.currentIndex, correct, points });
      return { correct, points, score: updated.score, streak: updated.streak };
    });
    // Announce AFTER commit so the /ws/watch bridge re-reads the persisted board.
    this.events.emitChanged(sessionId);
    return result;
  }

  /** Host ends the session early. */
  async endSession(p: Principal, sessionId: string): Promise<LiveQuizSessionDto> {
    return this.withEmit(p, sessionId, async (tx) => {
      const session = await this.requireSession(tx, sessionId);
      await this.assertHost(tx, p, session);
      if (session.status === "ENDED") throw new ConflictException("Session already ended");
      await tx.liveQuizSession.update({
        where: { id: sessionId },
        data: { status: "ENDED", endedAt: new Date(), questionStartedAt: null },
      });
      await this.log(tx, p, "quiz.session.end", sessionId, { reason: "host" });
      return this.buildSessionView(tx, sessionId, p);
    });
  }

  // --- reads --------------------------------------------------------------
  async getSession(p: Principal, sessionId: string): Promise<LiveQuizSessionDto> {
    return this.db.runAsTenant(this.ctx(p), async (tx) => {
      const session = await this.requireSession(tx, sessionId);
      await this.assertCanView(tx, p, session);
      return this.buildSessionView(tx, sessionId, p);
    });
  }

  /**
   * Discoverable sessions the caller can see/join: school-wide staff see all
   * open sessions; a teacher sees sessions for classes they teach; a student sees
   * sessions for classes they're enrolled in (plus any they joined). LOBBY/ACTIVE
   * only. No answerIndex ever crosses the wire here.
   */
  async listSessions(p: Principal): Promise<LiveQuizSessionSummaryDto[]> {
    return this.db.runAsTenant(this.ctx(p), async (tx) => {
      let sessions;
      if (this.isSchoolWide(p)) {
        sessions = await tx.liveQuizSession.findMany({
          where: { status: { in: ["LOBBY", "ACTIVE"] } },
          orderBy: { createdAt: "desc" },
          take: 50,
        });
      } else {
        const [taught, enrolled, joined] = await Promise.all([
          tx.classTeacher.findMany({ where: { teacherId: p.userId }, select: { classId: true } }),
          tx.enrollment.findMany({ where: { studentId: p.userId }, select: { classId: true } }),
          tx.liveQuizParticipant.findMany({ where: { userId: p.userId }, select: { sessionId: true } }),
        ]);
        const classIds = [...new Set([...taught.map((t) => t.classId), ...enrolled.map((e) => e.classId)])];
        const sessionIds = joined.map((j) => j.sessionId);
        sessions = await tx.liveQuizSession.findMany({
          where: {
            status: { in: ["LOBBY", "ACTIVE"] },
            OR: [{ classId: { in: classIds } }, { id: { in: sessionIds } }, { hostId: p.userId }],
          },
          orderBy: { createdAt: "desc" },
          take: 50,
        });
      }
      if (sessions.length === 0) return [];

      const quizIds = [...new Set(sessions.map((s) => s.quizId))];
      const classIdsForNames = [...new Set(sessions.map((s) => s.classId).filter((c): c is string => !!c))];
      const sessionIds = sessions.map((s) => s.id);
      const [quizzes, classes, counts, mine] = await Promise.all([
        tx.liveQuiz.findMany({ where: { id: { in: quizIds } }, select: { id: true, title: true, theme: true, difficulty: true } }),
        tx.class.findMany({ where: { id: { in: classIdsForNames } }, select: { id: true, name: true } }),
        tx.liveQuizParticipant.groupBy({ by: ["sessionId"], where: { sessionId: { in: sessionIds } }, _count: { _all: true } }),
        tx.liveQuizParticipant.findMany({ where: { sessionId: { in: sessionIds }, userId: p.userId }, select: { sessionId: true } }),
      ]);
      const quizById = new Map(quizzes.map((q) => [q.id, q]));
      const nameByClass = new Map(classes.map((c) => [c.id, c.name]));
      const countBySession = new Map(counts.map((c) => [c.sessionId, c._count._all]));
      const joinedSet = new Set(mine.map((m) => m.sessionId));

      return sessions.map((s) => {
        const quiz = quizById.get(s.quizId);
        return {
          id: s.id,
          quizId: s.quizId,
          title: quiz?.title ?? "Quiz",
          theme: (quiz?.theme ?? "GENERAL") as QuizThemeDto,
          difficulty: (quiz?.difficulty ?? "MEDIUM") as QuizDifficultyDto,
          classId: s.classId,
          className: s.classId ? nameByClass.get(s.classId) ?? null : null,
          status: s.status as LiveQuizSessionSummaryDto["status"],
          participantCount: countBySession.get(s.id) ?? 0,
          joined: joinedSet.has(s.id),
          isHost: s.hostId === p.userId,
          createdAt: s.createdAt,
        };
      });
    });
  }

  // =========================================================================
  // internals
  // =========================================================================
  private async assertGamesEnabled(tx: TenantTx, schoolId: string): Promise<void> {
    const settings = effectiveGameSettings(await tx.gameSettings.findFirst({ where: { schoolId } }));
    if (!settings.gamesEnabled) throw new ForbiddenException("Games are disabled for your school");
  }

  private async assertTeacherOfClass(tx: TenantTx, p: Principal, classId: string): Promise<void> {
    const cls = await tx.class.findFirst({ where: { id: classId }, select: { id: true } });
    if (!cls) throw new NotFoundException("Class not found");
    if (this.isSchoolWide(p)) return;
    const teaches = await tx.classTeacher.findFirst({ where: { classId, teacherId: p.userId }, select: { id: true } });
    if (!teaches) throw new NotFoundException("Class not found");
  }

  private async assertEnrolled(tx: TenantTx, p: Principal, classId: string | null): Promise<void> {
    if (!classId) throw new NotFoundException("Session not found");
    if (this.isSchoolWide(p)) return;
    const enrolled = await tx.enrollment.findFirst({ where: { classId, studentId: p.userId }, select: { id: true } });
    if (!enrolled) throw new NotFoundException("Session not found");
  }

  private async assertHost(
    tx: TenantTx,
    p: Principal,
    session: { hostId: string; classId: string | null },
  ): Promise<void> {
    if (this.isSchoolWide(p) || session.hostId === p.userId) return;
    // A teacher of the class may also drive the session.
    if (session.classId) {
      const teaches = await tx.classTeacher.findFirst({
        where: { classId: session.classId, teacherId: p.userId },
        select: { id: true },
      });
      if (teaches) return;
    }
    throw new NotFoundException("Session not found");
  }

  private async assertCanView(
    tx: TenantTx,
    p: Principal,
    session: { id: string; hostId: string; classId: string | null },
  ): Promise<void> {
    if (this.isSchoolWide(p) || session.hostId === p.userId) return;
    const seat = await tx.liveQuizParticipant.findFirst({ where: { sessionId: session.id, userId: p.userId } });
    if (seat) return;
    if (session.classId) {
      const teaches = await tx.classTeacher.findFirst({
        where: { classId: session.classId, teacherId: p.userId },
        select: { id: true },
      });
      if (teaches) return;
      const enrolled = await tx.enrollment.findFirst({
        where: { classId: session.classId, studentId: p.userId },
        select: { id: true },
      });
      if (enrolled) return;
    }
    throw new NotFoundException("Session not found");
  }

  private async requireSession(tx: TenantTx, sessionId: string) {
    const session = await tx.liveQuizSession.findFirst({ where: { id: sessionId } });
    if (!session) throw new NotFoundException("Session not found");
    return session;
  }

  private async displayName(tx: TenantTx, userId: string): Promise<string> {
    const u = await tx.user.findFirst({ where: { id: userId }, select: { name: true } });
    return u?.name ?? "Player";
  }

  private async buildQuizView(tx: TenantTx, quizId: string): Promise<LiveQuizDto> {
    const quiz = await tx.liveQuiz.findFirst({ where: { id: quizId } });
    if (!quiz) throw new NotFoundException("Quiz not found");
    const questions = await tx.liveQuizQuestion.findMany({
      where: { quizId },
      orderBy: { orderIndex: "asc" },
    });
    return {
      id: quiz.id,
      title: quiz.title,
      theme: quiz.theme as QuizThemeDto,
      difficulty: quiz.difficulty as QuizDifficultyDto,
      createdAt: quiz.createdAt,
      questions: questions.map((q) => ({
        orderIndex: q.orderIndex,
        prompt: q.prompt,
        choices: q.choices as unknown as string[],
        answerIndex: q.answerIndex,
      })),
    };
  }

  /**
   * Build the viewer-redacted session view. SECURITY: the current question's
   * answerIndex is included ONLY when the question has closed (its time limit has
   * elapsed) or the session has ENDED — never to a player mid-question.
   */
  private async buildSessionView(tx: TenantTx, sessionId: string, p: Principal): Promise<LiveQuizSessionDto> {
    const session = await this.requireSession(tx, sessionId);
    const quiz = await tx.liveQuiz.findFirst({ where: { id: session.quizId } });
    const total = await tx.liveQuizQuestion.count({ where: { quizId: session.quizId } });
    const difficulty = (quiz?.difficulty ?? "MEDIUM") as GameDifficulty;
    const timeLimitSeconds = QUIZ_DIFFICULTY_SPECS[isGameDifficulty(difficulty) ? difficulty : "MEDIUM"].timeLimitSeconds;

    const isHost = this.isSchoolWide(p) || session.hostId === p.userId;
    const me = await tx.liveQuizParticipant.findFirst({ where: { sessionId, userId: p.userId } });

    // Current question (player-redacted).
    let question: LiveQuizSessionDto["question"] = null;
    if (session.status === "ACTIVE" && session.currentIndex >= 0) {
      const q = await tx.liveQuizQuestion.findFirst({
        where: { quizId: session.quizId, orderIndex: session.currentIndex },
      });
      if (q) {
        const startedAt = session.questionStartedAt;
        const elapsedMs = startedAt ? Date.now() - startedAt.getTime() : 0;
        const closed = elapsedMs >= timeLimitSeconds * 1000;
        // Reveal the answer to the HOST always, and to players only once closed.
        const reveal = isHost || closed;
        question = {
          index: session.currentIndex,
          prompt: q.prompt,
          choices: q.choices as unknown as string[],
          timeLimitSeconds,
          startedAt,
          answerIndex: reveal ? q.answerIndex : null,
        };
      }
    }

    // Self state.
    let you: LiveQuizSessionDto["you"] = null;
    if (me) {
      let currentCorrect: boolean | null = null;
      let answeredCurrent = false;
      if (session.currentIndex >= 0) {
        const ans = await tx.liveQuizAnswer.findFirst({
          where: { sessionId, participantId: me.id, questionIndex: session.currentIndex },
        });
        if (ans) {
          answeredCurrent = true;
          currentCorrect = ans.correct;
        }
      }
      you = { participantId: me.id, score: me.score, streak: me.streak, answeredCurrent, currentCorrect };
    }

    // Leaderboard (top N by score).
    const parts = await tx.liveQuizParticipant.findMany({ where: { sessionId } });
    const standings: QuizStanding[] = parts.map((pt) => ({
      playerId: pt.userId,
      score: pt.score,
      correct: pt.correct,
      streak: pt.streak,
    }));
    const ranked = rankQuizStandings(standings).slice(0, LEADERBOARD_SIZE);
    const leaderboard = [];
    let rank = 1;
    for (const row of ranked) {
      leaderboard.push({
        userId: row.playerId,
        displayName: await this.displayName(tx, row.playerId),
        score: row.score,
        correct: row.correct,
        rank: rank++,
      });
    }

    return {
      id: session.id,
      quizId: session.quizId,
      title: quiz?.title ?? "Quiz",
      theme: (quiz?.theme ?? "GENERAL") as QuizThemeDto,
      difficulty: (quiz?.difficulty ?? "MEDIUM") as QuizDifficultyDto,
      classId: session.classId,
      status: session.status as LiveQuizSessionDto["status"],
      questionCount: total,
      currentIndex: session.currentIndex,
      question,
      you,
      leaderboard,
      isHost,
      participantCount: parts.length,
      startedAt: session.startedAt,
      endedAt: session.endedAt,
    };
  }

  private async log(
    tx: TenantTx,
    p: Principal,
    action: string,
    entityId: string,
    metadata?: Record<string, unknown>,
  ): Promise<void> {
    await this.audit.record(
      { actorId: p.userId, action, entity: "live_quiz", entityId, schoolId: p.schoolId, metadata },
      tx,
    );
  }
}
