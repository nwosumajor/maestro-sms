// =============================================================================
// LiveQuizController — REST surface for the Kahoot-style live quiz
// =============================================================================
// Authoring a quiz and hosting/driving a session is `game.quiz.host` (teacher:
// own classes; principal/school_admin: school-wide). Joining/answering is
// `game.play`. Reads are `game.leaderboard.read`. LiveQuizService narrows to the
// caller's school (RLS) + class relationship (404-not-403); a live question's
// correct answer never crosses the wire to a player until it closes.
// =============================================================================

import { Body, Controller, Delete, Get, Param, Post, Put } from "@nestjs/common";
import { GAME_PERMISSIONS, MODULES } from "@sms/types";
import type {
  LiveQuizAnswerResultDto,
  LiveQuizDto,
  LiveQuizSessionDto,
  LiveQuizSessionSummaryDto,
  LiveQuizSummaryDto,
} from "@sms/types";
import { z } from "zod";
import { RequireModule } from "../auth/require-module.decorator";
import { RequirePermission } from "../auth/require-permission.decorator";
import { CurrentPrincipal } from "../auth/current-principal.decorator";
import { ZodValidationPipe } from "../common/zod-validation.pipe";
import type { Principal } from "../integrity/integrity.foundation";
import { LiveQuizService } from "./live-quiz.service";

const questionSchema = z.object({
  prompt: z.string().min(1).max(500),
  choices: z.array(z.string().min(1).max(200)).min(2).max(6),
  answerIndex: z.number().int().min(0).max(5),
});
const createQuizSchema = z.object({
  title: z.string().min(1).max(160),
  theme: z.string(),
  difficulty: z.string(),
  questions: z.array(questionSchema).min(1).max(50),
});
const openSessionSchema = z.object({ quizId: z.string().uuid(), classId: z.string().uuid() });
const answerSchema = z.object({ choiceIndex: z.number().int().min(0).max(5) });

@RequireModule(MODULES.GAMES)
@Controller()
export class LiveQuizController {
  constructor(private readonly quiz: LiveQuizService) {}

  // --- authoring (host) ---------------------------------------------------
  @Post("quizzes")
  @RequirePermission(GAME_PERMISSIONS.QUIZ_HOST)
  create(
    @CurrentPrincipal() p: Principal,
    @Body(new ZodValidationPipe(createQuizSchema)) body: z.infer<typeof createQuizSchema>,
  ): Promise<LiveQuizDto> {
    return this.quiz.createQuiz(p, body);
  }

  @Get("quizzes")
  @RequirePermission(GAME_PERMISSIONS.QUIZ_HOST)
  list(@CurrentPrincipal() p: Principal): Promise<LiveQuizSummaryDto[]> {
    return this.quiz.listQuizzes(p);
  }

  @Get("quizzes/:id")
  @RequirePermission(GAME_PERMISSIONS.QUIZ_HOST)
  get(@CurrentPrincipal() p: Principal, @Param("id") id: string): Promise<LiveQuizDto> {
    return this.quiz.getQuiz(p, id);
  }

  @Put("quizzes/:id")
  @RequirePermission(GAME_PERMISSIONS.QUIZ_HOST)
  update(
    @CurrentPrincipal() p: Principal,
    @Param("id") id: string,
    @Body(new ZodValidationPipe(createQuizSchema)) body: z.infer<typeof createQuizSchema>,
  ): Promise<LiveQuizDto> {
    return this.quiz.updateQuiz(p, id, body);
  }

  @Delete("quizzes/:id")
  @RequirePermission(GAME_PERMISSIONS.QUIZ_HOST)
  remove(@CurrentPrincipal() p: Principal, @Param("id") id: string): Promise<{ id: string; archived: true }> {
    return this.quiz.archiveQuiz(p, id);
  }

  // --- session lifecycle --------------------------------------------------
  @Post("quiz-sessions")
  @RequirePermission(GAME_PERMISSIONS.QUIZ_HOST)
  open(
    @CurrentPrincipal() p: Principal,
    @Body(new ZodValidationPipe(openSessionSchema)) body: z.infer<typeof openSessionSchema>,
  ): Promise<LiveQuizSessionDto> {
    return this.quiz.openSession(p, body);
  }

  @Get("quiz-sessions")
  @RequirePermission(GAME_PERMISSIONS.LEADERBOARD_READ)
  listSessions(@CurrentPrincipal() p: Principal): Promise<LiveQuizSessionSummaryDto[]> {
    return this.quiz.listSessions(p);
  }

  @Get("quiz-sessions/:id")
  @RequirePermission(GAME_PERMISSIONS.LEADERBOARD_READ)
  getSession(@CurrentPrincipal() p: Principal, @Param("id") id: string): Promise<LiveQuizSessionDto> {
    return this.quiz.getSession(p, id);
  }

  @Post("quiz-sessions/:id/join")
  @RequirePermission(GAME_PERMISSIONS.PLAY)
  join(@CurrentPrincipal() p: Principal, @Param("id") id: string): Promise<LiveQuizSessionDto> {
    return this.quiz.joinSession(p, id);
  }

  @Post("quiz-sessions/:id/next")
  @RequirePermission(GAME_PERMISSIONS.QUIZ_HOST)
  next(@CurrentPrincipal() p: Principal, @Param("id") id: string): Promise<LiveQuizSessionDto> {
    return this.quiz.nextQuestion(p, id);
  }

  @Post("quiz-sessions/:id/answer")
  @RequirePermission(GAME_PERMISSIONS.PLAY)
  answer(
    @CurrentPrincipal() p: Principal,
    @Param("id") id: string,
    @Body(new ZodValidationPipe(answerSchema)) body: z.infer<typeof answerSchema>,
  ): Promise<LiveQuizAnswerResultDto> {
    return this.quiz.answer(p, id, body.choiceIndex);
  }

  @Post("quiz-sessions/:id/end")
  @RequirePermission(GAME_PERMISSIONS.QUIZ_HOST)
  end(@CurrentPrincipal() p: Principal, @Param("id") id: string): Promise<LiveQuizSessionDto> {
    return this.quiz.endSession(p, id);
  }
}
