import { isoDay } from "../common/calendar-day";
import { Body, Controller, Get, Param, Post, Query } from "@nestjs/common";
import { MODULES, HR_PERMISSIONS } from "@sms/types";
import type { StaffChecklistDto, StaffDocumentDto, TrainingRecordDto, StaffHandoverDto } from "@sms/types";
import { z } from "zod";
import { RequireModule } from "../auth/require-module.decorator";
import { RequirePermission } from "../auth/require-permission.decorator";
import { CurrentPrincipal } from "../auth/current-principal.decorator";
import { ZodValidationPipe } from "../common/zod-validation.pipe";
import type { Principal } from "../integrity/integrity.foundation";
import { StaffLifecycleService } from "./staff-lifecycle.service";
import { StaffHandoverService } from "./staff-handover.service";
import { JobRunsService } from "../maintenance/job-runs.service";

const checklistSchema = z.object({ type: z.enum(["ONBOARDING", "OFFBOARDING"]) });
const toggleSchema = z.object({ done: z.boolean() });
const documentSchema = z.object({
  kind: z.enum(["CONTRACT", "WORK_PERMIT", "CERTIFICATION", "MEDICAL", "OTHER"]),
  name: z.string().min(1).max(160),
  documentId: z.string().uuid().nullish(),
  expiresAt: isoDay.nullish(),
});
const trainingSchema = z.object({
  title: z.string().min(1).max(160),
  provider: z.string().max(160).nullish(),
  status: z.enum(["PLANNED", "COMPLETED"]).optional(),
  completedAt: isoDay.nullish(),
  expiresAt: isoDay.nullish(),
});

@RequireModule(MODULES.HR)
@Controller("hr/staff")
export class StaffLifecycleController {
  constructor(
    private readonly lifecycle: StaffLifecycleService,
    private readonly jobRuns: JobRunsService,
    private readonly handover: StaffHandoverService,
  ) {}

  /**
   * What this person still holds — classes, cover, invigilation, open tasks.
   *
   * Read-only and reassigns nothing: the platform cannot know who should take a
   * class, and quietly moving thirty assignments to a name it picked would be a
   * worse failure than the one being fixed. This is the list a human works
   * through, and it is worth asking BEFORE an exit as well as after — "what
   * would we have to cover" is the question a head asks when somebody resigns.
   */
  @Get(":userId/handover")
  @RequirePermission(HR_PERMISSIONS.HR_READ)
  handoverFor(@CurrentPrincipal() p: Principal, @Param("userId") userId: string): Promise<StaffHandoverDto> {
    return this.handover.openDuties(p, userId);
  }

  // --- checklists ------------------------------------------------------------
  @Post(":userId/checklists")
  @RequirePermission(HR_PERMISSIONS.HR_WRITE)
  createChecklist(
    @CurrentPrincipal() p: Principal,
    @Param("userId") userId: string,
    @Body(new ZodValidationPipe(checklistSchema)) body: z.infer<typeof checklistSchema>,
  ): Promise<StaffChecklistDto> {
    return this.lifecycle.createChecklist(p, userId, body.type);
  }

  @Get("checklists")
  @RequirePermission(HR_PERMISSIONS.HR_READ)
  listChecklists(@CurrentPrincipal() p: Principal, @Query("userId") userId?: string): Promise<StaffChecklistDto[]> {
    return this.lifecycle.listChecklists(p, userId);
  }

  @Post("checklist-items/:itemId/toggle")
  @RequirePermission(HR_PERMISSIONS.HR_WRITE)
  toggleItem(
    @CurrentPrincipal() p: Principal,
    @Param("itemId") itemId: string,
    @Body(new ZodValidationPipe(toggleSchema)) body: z.infer<typeof toggleSchema>,
  ): Promise<StaffChecklistDto> {
    return this.lifecycle.toggleItem(p, itemId, body.done);
  }

  // --- documents -------------------------------------------------------------
  @Post(":userId/documents")
  @RequirePermission(HR_PERMISSIONS.HR_WRITE)
  addDocument(
    @CurrentPrincipal() p: Principal,
    @Param("userId") userId: string,
    @Body(new ZodValidationPipe(documentSchema)) body: z.infer<typeof documentSchema>,
  ): Promise<StaffDocumentDto> {
    return this.lifecycle.addDocument(p, userId, body);
  }

  @Get("documents")
  @RequirePermission(HR_PERMISSIONS.HR_READ)
  listDocuments(@CurrentPrincipal() p: Principal, @Query("userId") userId?: string): Promise<StaffDocumentDto[]> {
    return this.lifecycle.listDocuments(p, userId);
  }

  @Post("documents/reminders/run")
  @RequirePermission(HR_PERMISSIONS.HR_WRITE)
  runReminders(@CurrentPrincipal() p: Principal): Promise<{ reminded: number }> {
    return this.jobRuns.record("hr.staffReminders", "MANUAL", () =>
      this.lifecycle.runDocumentReminders(p),
    );
  }

  // --- training --------------------------------------------------------------
  @Post(":userId/training")
  @RequirePermission(HR_PERMISSIONS.HR_WRITE)
  addTraining(
    @CurrentPrincipal() p: Principal,
    @Param("userId") userId: string,
    @Body(new ZodValidationPipe(trainingSchema)) body: z.infer<typeof trainingSchema>,
  ): Promise<TrainingRecordDto> {
    return this.lifecycle.addTraining(p, userId, body);
  }

  @Get("training")
  @RequirePermission(HR_PERMISSIONS.HR_READ)
  listTraining(@CurrentPrincipal() p: Principal, @Query("userId") userId?: string): Promise<TrainingRecordDto[]> {
    return this.lifecycle.listTraining(p, userId);
  }
}
