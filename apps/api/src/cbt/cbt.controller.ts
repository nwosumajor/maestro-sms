// CBT exam hall — add-on module (MODULES.CBT). Staff (cbt.manage) author banks
// and run exams; students (cbt.take) sit them. Every answer key stays
// server-side until a sitting closes; the clock is server law.

import { Body, Controller, Get, Param, Post, Put } from "@nestjs/common";
import { CBT_PERMISSIONS, MODULES } from "@sms/types";
import type { CbtBankDto, CbtExamDto, CbtExamResultsDto, CbtSittingViewDto } from "@sms/types";
import { z } from "zod";
import { RequireModule } from "../auth/require-module.decorator";
import { RequirePermission } from "../auth/require-permission.decorator";
import { CurrentPrincipal } from "../auth/current-principal.decorator";
import { ZodValidationPipe } from "../common/zod-validation.pipe";
import type { Principal } from "../integrity/integrity.foundation";
import { CbtService } from "./cbt.service";

const bankSchema = z.object({ name: z.string().min(1).max(160), subject: z.string().max(80).nullish() });
const questionsSchema = z.object({
  questions: z
    .array(
      z.object({
        prompt: z.string().min(1).max(2000),
        choices: z.array(z.string().min(1).max(500)).min(2).max(6),
        answerIndex: z.number().int().min(0).max(5),
      }),
    )
    .min(1)
    .max(500),
});
const examSchema = z.object({
  bankId: z.string().uuid(),
  title: z.string().min(1).max(200),
  classId: z.string().uuid().nullish(),
  questionCount: z.number().int().min(1).max(200),
  durationMinutes: z.number().int().min(5).max(300),
  startAt: z.string().datetime(),
  endAt: z.string().datetime(),
});
const statusSchema = z.object({ status: z.enum(["PUBLISHED", "CLOSED"]) });
const answerSchema = z.object({ questionId: z.string().uuid(), choiceIndex: z.number().int().min(0).max(5) });

@RequireModule(MODULES.CBT)
@Controller("cbt")
export class CbtController {
  constructor(private readonly cbt: CbtService) {}

  // --- staff -------------------------------------------------------------------
  @Get("banks")
  @RequirePermission(CBT_PERMISSIONS.CBT_MANAGE)
  listBanks(@CurrentPrincipal() p: Principal): Promise<CbtBankDto[]> {
    return this.cbt.listBanks(p);
  }

  @Post("banks")
  @RequirePermission(CBT_PERMISSIONS.CBT_MANAGE)
  createBank(@CurrentPrincipal() p: Principal, @Body(new ZodValidationPipe(bankSchema)) body: z.infer<typeof bankSchema>) {
    return this.cbt.createBank(p, body);
  }

  @Post("banks/:id/questions")
  @RequirePermission(CBT_PERMISSIONS.CBT_MANAGE)
  addQuestions(
    @CurrentPrincipal() p: Principal,
    @Param("id") id: string,
    @Body(new ZodValidationPipe(questionsSchema)) body: z.infer<typeof questionsSchema>,
  ) {
    return this.cbt.addQuestions(p, id, body.questions);
  }

  @Post("exams")
  @RequirePermission(CBT_PERMISSIONS.CBT_MANAGE)
  createExam(@CurrentPrincipal() p: Principal, @Body(new ZodValidationPipe(examSchema)) body: z.infer<typeof examSchema>) {
    return this.cbt.createExam(p, body);
  }

  @Put("exams/:id/status")
  @RequirePermission(CBT_PERMISSIONS.CBT_MANAGE)
  setStatus(
    @CurrentPrincipal() p: Principal,
    @Param("id") id: string,
    @Body(new ZodValidationPipe(statusSchema)) body: z.infer<typeof statusSchema>,
  ) {
    return this.cbt.setExamStatus(p, id, body.status);
  }

  @Get("exams/:id/results")
  @RequirePermission(CBT_PERMISSIONS.CBT_MANAGE)
  results(@CurrentPrincipal() p: Principal, @Param("id") id: string): Promise<CbtExamResultsDto> {
    return this.cbt.examResults(p, id);
  }

  // --- exam lists (two explicit routes: guard takes ONE permission) --------------
  /** Staff: every exam, all statuses. */
  @Get("exams/all")
  @RequirePermission(CBT_PERMISSIONS.CBT_MANAGE)
  listAllExams(@CurrentPrincipal() p: Principal): Promise<CbtExamDto[]> {
    return this.cbt.listExams(p, true);
  }

  /** Students: published exams they can sit (class-scoped, window-live). */
  @Get("exams")
  @RequirePermission(CBT_PERMISSIONS.CBT_TAKE)
  listExams(@CurrentPrincipal() p: Principal): Promise<CbtExamDto[]> {
    return this.cbt.listExams(p, false);
  }

  // --- students ------------------------------------------------------------------
  @Post("exams/:id/start")
  @RequirePermission(CBT_PERMISSIONS.CBT_TAKE)
  start(@CurrentPrincipal() p: Principal, @Param("id") id: string): Promise<CbtSittingViewDto> {
    return this.cbt.startSitting(p, id);
  }

  @Get("sittings/:id")
  @RequirePermission(CBT_PERMISSIONS.CBT_TAKE)
  sitting(@CurrentPrincipal() p: Principal, @Param("id") id: string): Promise<CbtSittingViewDto> {
    return this.cbt.getSitting(p, id);
  }

  @Post("sittings/:id/answer")
  @RequirePermission(CBT_PERMISSIONS.CBT_TAKE)
  answer(
    @CurrentPrincipal() p: Principal,
    @Param("id") id: string,
    @Body(new ZodValidationPipe(answerSchema)) body: z.infer<typeof answerSchema>,
  ) {
    return this.cbt.answer(p, id, body.questionId, body.choiceIndex);
  }

  @Post("sittings/:id/submit")
  @RequirePermission(CBT_PERMISSIONS.CBT_TAKE)
  submit(@CurrentPrincipal() p: Principal, @Param("id") id: string): Promise<CbtSittingViewDto> {
    return this.cbt.submit(p, id);
  }
}
