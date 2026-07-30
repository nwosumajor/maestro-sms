// CBT exam hall — add-on module (MODULES.CBT). Staff (cbt.manage) author banks
// and run exams; students (cbt.take) sit them. Every answer key stays
// server-side until a sitting closes; the clock is server law.

import { Body, Controller, Get, Param, Post, Put, Query } from "@nestjs/common";
import { CBT_PERMISSIONS, CBT_BLUEPRINT_MAX_ITEMS, CBT_QUESTION_TYPES, CBT_INTEGRITY_BATCH_MAX, MODULES } from "@sms/types";
import type { CbtAuthoringOptionsDto, CbtBankDto, CbtExamDto, CbtExamResultsDto, CbtSittingViewDto, CbtBankQuestionsDto, CbtAvailabilityDto, CbtMarkingQueueDto, CbtMarkingProgressDto, CbtIntegritySummaryDto } from "@sms/types";
import { z } from "zod";
import { RequireModule } from "../auth/require-module.decorator";
import { RequirePermission } from "../auth/require-permission.decorator";
import { CurrentPrincipal } from "../auth/current-principal.decorator";
import { ZodValidationPipe } from "../common/zod-validation.pipe";
import type { Principal } from "../integrity/integrity.foundation";
import { CbtService } from "./cbt.service";

const bankSchema = z.object({
  name: z.string().min(1).max(160),
  subject: z.string().max(80).nullish(),
  subjectId: z.string().uuid().nullish(),
});
const questionsSchema = z.object({
  questions: z
    .array(
      z.object({
        prompt: z.string().min(1).max(2000),
        // Theory questions carry no choices; the service validates per type.
        choices: z.array(z.string().min(1).max(500)).max(6).default([]),
        answerIndex: z.number().int().min(0).max(5).default(0),
        type: z.enum(CBT_QUESTION_TYPES).optional(),
        maxMarks: z.number().int().min(1).max(100).nullish(),
        markGuide: z.string().max(4000).nullish(),
        // Curriculum level this question targets; omit for "any level".
        level: z.number().int().min(1).max(20).nullish(),
        topic: z.string().max(80).nullish(),
      }),
    )
    .min(1)
    .max(500),
});
const examSchema = z.object({
  bankId: z.string().uuid(),
  title: z.string().min(1).max(200),
  classId: z.string().uuid().nullish(),
  // Section sizes. objectiveCount defaults to questionCount for callers that
  // predate sections; theoryCount 0 (default) = objective-only paper.
  questionCount: z.number().int().min(0).max(200),
  objectiveCount: z.number().int().min(0).max(200).optional(),
  theoryCount: z.number().int().min(0).max(50).optional(),
  durationMinutes: z.number().int().min(5).max(300),
  startAt: z.string().datetime(),
  endAt: z.string().datetime(),
  // Optional per-topic paper definition. When present it REPLACES questionCount
  // (the total becomes the sum of the lines) and is validated against the bank.
  blueprint: z
    .array(z.object({ topic: z.string().min(1).max(80), count: z.number().int().min(1).max(200) }))
    .max(CBT_BLUEPRINT_MAX_ITEMS)
    .nullish(),
});
// Publishing is maker-checker (POST exams/:id/request-publish) — the only
// direct status change left is closing a live exam early.
const statusSchema = z.object({ status: z.enum(["CLOSED"]) });
const theoryAnswerSchema = z.object({ questionId: z.string().uuid(), text: z.string().max(20000) });
const integritySchema = z.object({
  events: z
    .array(
      z.object({
        type: z.enum(["FOCUS_LOSS", "PASTE"]),
        awayMs: z.number().int().min(0).max(6 * 60 * 60 * 1000).optional(),
        chars: z.number().int().min(0).max(100_000).optional(),
      }),
    )
    .min(1)
    .max(CBT_INTEGRITY_BATCH_MAX),
});
const markSchema = z.object({ marks: z.number().int().min(0).max(100), comment: z.string().max(2000).nullish() });
const answerSchema = z.object({ questionId: z.string().uuid(), choiceIndex: z.number().int().min(0).max(5) });

@RequireModule(MODULES.CBT)
@Controller("cbt")
export class CbtController {
  constructor(private readonly cbt: CbtService) {}

  // --- staff -------------------------------------------------------------------
  /** The caller's authoring scope: their subjects/classes (teacher) or all (admin). */
  @Get("authoring-options")
  @RequirePermission(CBT_PERMISSIONS.CBT_MANAGE)
  authoringOptions(@CurrentPrincipal() p: Principal): Promise<CbtAuthoringOptionsDto> {
    return this.cbt.authoringOptions(p);
  }

  /** Ungated for the same reason as banks/:id/questions — cbt.manage (authors) and
   *  cbt.review (oversight) must BOTH reach it, and @RequirePermission takes one.
   *  CbtService.listBanks enforces "either", and scopes the rows per audience. */
  @Get("banks")
  listBanks(@CurrentPrincipal() p: Principal): Promise<CbtBankDto[]> {
    return this.cbt.listBanks(p);
  }

  @Post("banks")
  @RequirePermission(CBT_PERMISSIONS.CBT_MANAGE)
  createBank(@CurrentPrincipal() p: Principal, @Body(new ZodValidationPipe(bankSchema)) body: z.infer<typeof bankSchema>) {
    return this.cbt.createBank(p, body);
  }

  /**
   * Read a bank's questions. Two DIFFERENT permissions may reach it — a subject
   * teacher via cbt.manage (their own banks only) or an oversight reader via
   * cbt.review (any bank, no answer key) — and @RequirePermission takes exactly
   * one. So the route is ungated and CbtService.getBankQuestions enforces
   * "cbt.manage + bank scope OR cbt.review", 404-not-403 otherwise. Gating on
   * either permission here would lock out the other audience.
   */
  @Get("banks/:id/questions")
  bankQuestions(@CurrentPrincipal() p: Principal, @Param("id") id: string): Promise<CbtBankQuestionsDto> {
    return this.cbt.getBankQuestions(p, id);
  }

  /**
   * What can actually be drawn for this bank + class: the resolved level, the
   * total matching pool, and per-topic counts. Lets the exam form show real
   * numbers BEFORE a paper is defined instead of failing at creation. Ungated for
   * the same reason as banks/:id/questions (two audiences); the service enforces
   * cbt.manage + scope OR cbt.review.
   */
  @Get("banks/:id/availability")
  availability(
    @CurrentPrincipal() p: Principal,
    @Param("id") id: string,
    @Query("classId") classId?: string,
  ): Promise<CbtAvailabilityDto> {
    return this.cbt.availability(p, id, classId ?? null);
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

  /** Maker-checker: park the draft PENDING_APPROVAL + raise CBT_EXAM_PUBLISH. */
  @Post("exams/:id/request-publish")
  @RequirePermission(CBT_PERMISSIONS.CBT_MANAGE)
  requestPublish(@CurrentPrincipal() p: Principal, @Param("id") id: string) {
    return this.cbt.requestPublish(p, id);
  }

  /** Maker-checker: request the answer-key release (principal approves). */
  @Post("exams/:id/request-answer-release")
  @RequirePermission(CBT_PERMISSIONS.CBT_MANAGE)
  requestAnswerRelease(@CurrentPrincipal() p: Principal, @Param("id") id: string) {
    return this.cbt.requestAnswerRelease(p, id);
  }

  /**
   * ONE PRESS: record this paper's scores (Section A + Section B) into every
   * candidate's gradesheet for the exam component. Refuses while any theory answer
   * is unmarked, so a provisional total is never filed as a term grade.
   */
  @Post("exams/:id/record-grades")
  @RequirePermission(CBT_PERMISSIONS.CBT_MANAGE)
  recordGrades(@CurrentPrincipal() p: Principal, @Param("id") id: string) {
    return this.cbt.recordExamGrades(p, id);
  }

  /** Per-candidate integrity report for staff review. */
  @Get("exams/:id/integrity")
  @RequirePermission(CBT_PERMISSIONS.CBT_MANAGE)
  examIntegrity(@CurrentPrincipal() p: Principal, @Param("id") id: string): Promise<CbtIntegritySummaryDto[]> {
    return this.cbt.examIntegrity(p, id);
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
  listAllExams(@CurrentPrincipal() p: Principal, @Query("status") status?: string): Promise<CbtExamDto[]> {
    // Optional status narrows server-side (the exams page asks for DRAFT only).
    // Unknown values simply match nothing rather than 400 — this is a filter, not
    // a command, and an empty list is the honest answer.
    return this.cbt.listExams(p, true, status?.trim() || undefined);
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

  /** Candidate saves a THEORY answer (one row upserted, not a JSON blob). */
  @Post("sittings/:id/answer-theory")
  @RequirePermission(CBT_PERMISSIONS.CBT_TAKE)
  answerTheory(
    @CurrentPrincipal() p: Principal,
    @Param("id") id: string,
    @Body(new ZodValidationPipe(theoryAnswerSchema)) body: z.infer<typeof theoryAnswerSchema>,
  ) {
    return this.cbt.answerTheory(p, id, body.questionId, body.text);
  }

  // --- marking (staff) ----------------------------------------------------------
  /** The VERTICAL marking queue for one question: every candidate's answer. */
  @Get("exams/:id/marking")
  @RequirePermission(CBT_PERMISSIONS.CBT_MANAGE)
  markingQueue(
    @CurrentPrincipal() p: Principal,
    @Param("id") id: string,
    @Query("questionId") questionId: string,
    @Query("reveal") reveal?: string,
  ): Promise<CbtMarkingQueueDto> {
    return this.cbt.markingQueue(p, id, questionId, { reveal: reveal === "true" });
  }

  /** Per-question progress + whether results are still PROVISIONAL. */
  @Get("exams/:id/marking/progress")
  @RequirePermission(CBT_PERMISSIONS.CBT_MANAGE)
  markingProgress(@CurrentPrincipal() p: Principal, @Param("id") id: string): Promise<CbtMarkingProgressDto> {
    return this.cbt.markingProgress(p, id);
  }

  /** Award a mark to one answer. */
  @Post("marking/:answerId")
  @RequirePermission(CBT_PERMISSIONS.CBT_MANAGE)
  markAnswer(
    @CurrentPrincipal() p: Principal,
    @Param("answerId") answerId: string,
    @Body(new ZodValidationPipe(markSchema)) body: z.infer<typeof markSchema>,
  ) {
    return this.cbt.markAnswer(p, answerId, body.marks, body.comment);
  }

  /**
   * Candidate's own sitting reports integrity events (left the tab, pasted).
   * SIGNALS ONLY — recording one never penalises, voids or submits the paper
   * (Golden Rule #8). Staff are notified once a sitting crosses the threshold.
   */
  @Post("sittings/:id/integrity")
  @RequirePermission(CBT_PERMISSIONS.CBT_TAKE)
  integrity(
    @CurrentPrincipal() p: Principal,
    @Param("id") id: string,
    @Body(new ZodValidationPipe(integritySchema)) body: z.infer<typeof integritySchema>,
  ) {
    return this.cbt.recordIntegrityEvents(p, id, body.events);
  }

  @Post("sittings/:id/submit")
  @RequirePermission(CBT_PERMISSIONS.CBT_TAKE)
  submit(@CurrentPrincipal() p: Principal, @Param("id") id: string): Promise<CbtSittingViewDto> {
    return this.cbt.submit(p, id);
  }
}
