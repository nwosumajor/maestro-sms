import { Body, Controller, Delete, Get, Param, Patch, Post, Put, Query, Res, StreamableFile } from "@nestjs/common";
import type { Response } from "express";
import { MODULES } from "@sms/types";
import { RequireModule } from "../auth/require-module.decorator";
import type {
  IdNameDto,
  PeriodDto,
  TeacherUnavailabilityDto,
  TimetableEntryDto,
  TimetableGenerateResultDto,
  CoverLessonDto,
  UnstaffedLessonDto,
  MyCoverDutyDto,
} from "@sms/types";
import { z } from "zod";
import { DAYS_OF_WEEK, TIMETABLE_PERMISSIONS } from "@sms/types";
import { RequirePermission } from "../auth/require-permission.decorator";
import { CurrentPrincipal } from "../auth/current-principal.decorator";
import { ZodValidationPipe } from "../common/zod-validation.pipe";
import type { Principal } from "../integrity/integrity.foundation";
import { TimetableService } from "./timetable.service";
import { LessonCoverService } from "./lesson-cover.service";

const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);
const periodSchema = z.object({
  name: z.string().min(1).max(60),
  sequence: z.number().int().min(1).max(50),
  startTime: hhmm,
  endTime: hhmm,
});
const periodUpdateSchema = periodSchema.partial();
const dayStructureSchema = z.object({
  teachingPeriods: z.number().int().min(1).max(50),
  dayStart: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
  periodMinutes: z.number().int().min(1).max(600),
  breaks: z
    .array(
      z.object({
        afterPeriod: z.number().int().min(1),
        minutes: z.number().int().min(1).max(600),
        name: z.string().min(1).max(40).optional(),
      }),
    )
    .max(20)
    .default([]),
});
const roomSchema = z.object({ name: z.string().min(1).max(80), capacity: z.number().int().min(1).nullish() });
const roomUpdateSchema = roomSchema.partial();
const entrySchema = z.object({
  classId: z.string().uuid(),
  dayOfWeek: z.enum(DAYS_OF_WEEK),
  periodId: z.string().uuid(),
  subjectId: z.string().uuid(),
  teacherId: z.string().uuid(),
  roomId: z.string().uuid().nullish(),
});
const generateSchema = z.object({
  classIds: z.array(z.string().uuid()).optional(),
  lessonsPerSubject: z.number().int().min(1).max(10).optional(),
  days: z.array(z.enum(DAYS_OF_WEEK)).optional(),
  replace: z.boolean().optional(),
});
const availabilitySchema = z.object({
  slots: z
    .array(z.object({ dayOfWeek: z.enum(DAYS_OF_WEEK), periodId: z.string().uuid() }))
    .max(350), // 7 days x 50 periods — the whole grid
});
const entryUpdateSchema = entrySchema.partial();
const coverSchema = z.object({
  timetableEntryId: z.string().uuid(),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  coveringTeacherId: z.string().uuid(),
  note: z.string().max(500).optional(),
});

@RequireModule(MODULES.TIMETABLE)
@Controller("timetable")
export class TimetableController {
  constructor(
    private readonly timetable: TimetableService,
    private readonly cover: LessonCoverService,
  ) {}

  // --- teacher cover (substitution for teachers on leave) ---
  /** Lessons whose regular teacher is on approved leave in [from,to], with any
   *  assigned cover. Staff-wide read. */
  @Get("cover")
  @RequirePermission(TIMETABLE_PERMISSIONS.TIMETABLE_READ)
  coverList(
    @CurrentPrincipal() p: Principal,
    @Query("from") from: string,
    @Query("to") to: string,
  ): Promise<CoverLessonDto[]> {
    return this.cover.lessonsNeedingCover(p, from, to);
  }

  /** The caller's own cover duties in [from,to]. Any teacher (self-scoped). */
  @Get("cover/mine")
  @RequirePermission(TIMETABLE_PERMISSIONS.TIMETABLE_READ)
  myCover(
    @CurrentPrincipal() p: Principal,
    // Optional: the server defaults the window in the SCHOOL's timezone.
    @Query("from") from?: string,
    @Query("to") to?: string,
  ): Promise<MyCoverDutyDto[]> {
    return this.cover.myDuties(p, from, to);
  }

  /** Assign a reliever to a dated lesson. Timetable managers. */
  @Post("cover")
  @RequirePermission(TIMETABLE_PERMISSIONS.TIMETABLE_WRITE)
  assignCover(
    @CurrentPrincipal() p: Principal,
    @Body(new ZodValidationPipe(coverSchema)) body: z.infer<typeof coverSchema>,
  ): Promise<CoverLessonDto> {
    return this.cover.assignCover(p, body);
  }

  /** Remove a cover assignment. */
  @Delete("cover/:id")
  @RequirePermission(TIMETABLE_PERMISSIONS.TIMETABLE_WRITE)
  removeCover(@CurrentPrincipal() p: Principal, @Param("id") id: string) {
    return this.cover.removeCover(p, id);
  }

  // --- periods ---
  /**
   * Lessons whose regular teacher has left the school.
   *
   * A departure closes the account but not the timetable, and nothing else in
   * the product tells a school that a lesson has no teacher.
   */
  @Get("unstaffed")
  @RequirePermission(TIMETABLE_PERMISSIONS.TIMETABLE_READ)
  unstaffed(@CurrentPrincipal() p: Principal): Promise<UnstaffedLessonDto[]> {
    return this.timetable.unstaffedLessons(p);
  }

  @Get("periods")
  @RequirePermission(TIMETABLE_PERMISSIONS.TIMETABLE_READ)
  listPeriods(@CurrentPrincipal() p: Principal): Promise<PeriodDto[]> {
    return this.timetable.listPeriods(p);
  }

  @Post("periods")
  @RequirePermission(TIMETABLE_PERMISSIONS.TIMETABLE_WRITE)
  createPeriod(
    @CurrentPrincipal() p: Principal,
    @Body(new ZodValidationPipe(periodSchema)) body: z.infer<typeof periodSchema>,
  ) {
    return this.timetable.createPeriod(p, body);
  }

  /** Generate the whole day from teaching-period count + break positions. */
  @Post("periods/generate")
  @RequirePermission(TIMETABLE_PERMISSIONS.TIMETABLE_WRITE)
  generateDay(
    @CurrentPrincipal() p: Principal,
    @Body(new ZodValidationPipe(dayStructureSchema)) body: z.infer<typeof dayStructureSchema>,
  ): Promise<PeriodDto[]> {
    return this.timetable.generateDay(p, body);
  }

  @Patch("periods/:id")
  @RequirePermission(TIMETABLE_PERMISSIONS.TIMETABLE_WRITE)
  updatePeriod(
    @CurrentPrincipal() p: Principal,
    @Param("id") id: string,
    @Body(new ZodValidationPipe(periodUpdateSchema)) body: z.infer<typeof periodUpdateSchema>,
  ) {
    return this.timetable.updatePeriod(p, id, body);
  }

  /** Remove a period. 409 (naming the count) while lessons are scheduled in it. */
  @Delete("periods/:id")
  @RequirePermission(TIMETABLE_PERMISSIONS.TIMETABLE_WRITE)
  deletePeriod(@CurrentPrincipal() p: Principal, @Param("id") id: string) {
    return this.timetable.deletePeriod(p, id);
  }

  // --- rooms ---
  @Get("rooms")
  @RequirePermission(TIMETABLE_PERMISSIONS.TIMETABLE_READ)
  listRooms(@CurrentPrincipal() p: Principal): Promise<IdNameDto[]> {
    return this.timetable.listRooms(p);
  }

  @Post("rooms")
  @RequirePermission(TIMETABLE_PERMISSIONS.TIMETABLE_WRITE)
  createRoom(
    @CurrentPrincipal() p: Principal,
    @Body(new ZodValidationPipe(roomSchema)) body: z.infer<typeof roomSchema>,
  ) {
    return this.timetable.createRoom(p, body);
  }

  @Patch("rooms/:id")
  @RequirePermission(TIMETABLE_PERMISSIONS.TIMETABLE_WRITE)
  updateRoom(
    @CurrentPrincipal() p: Principal,
    @Param("id") id: string,
    @Body(new ZodValidationPipe(roomUpdateSchema)) body: z.infer<typeof roomUpdateSchema>,
  ) {
    return this.timetable.updateRoom(p, id, body);
  }

  /** Remove a room. 409 while lessons are scheduled in it or an offering
   *  still names it as preferred. */
  @Delete("rooms/:id")
  @RequirePermission(TIMETABLE_PERMISSIONS.TIMETABLE_WRITE)
  deleteRoom(@CurrentPrincipal() p: Principal, @Param("id") id: string) {
    return this.timetable.deleteRoom(p, id);
  }

  /** Auto-generate a conflict-free weekly grid from class-subject-teacher
   *  offerings via the CSP solver (quotas + teacher availability + rooms). */
  @Post("generate")
  @RequirePermission(TIMETABLE_PERMISSIONS.TIMETABLE_WRITE)
  generate(
    @CurrentPrincipal() p: Principal,
    @Body(new ZodValidationPipe(generateSchema)) body: z.infer<typeof generateSchema>,
  ): Promise<TimetableGenerateResultDto> {
    return this.timetable.generate(p, body);
  }

  // --- teacher availability (CSP generator input) ---
  @Get("availability")
  @RequirePermission(TIMETABLE_PERMISSIONS.TIMETABLE_READ)
  listAvailability(
    @CurrentPrincipal() p: Principal,
    @Query("teacherId") teacherId?: string,
  ): Promise<TeacherUnavailabilityDto[]> {
    return this.timetable.listUnavailability(p, teacherId);
  }

  /** Replace a teacher's full set of unavailable (day, period) slots. */
  @Put("availability/:teacherId")
  @RequirePermission(TIMETABLE_PERMISSIONS.TIMETABLE_WRITE)
  setAvailability(
    @CurrentPrincipal() p: Principal,
    @Param("teacherId") teacherId: string,
    @Body(new ZodValidationPipe(availabilitySchema)) body: z.infer<typeof availabilitySchema>,
  ) {
    return this.timetable.setUnavailability(p, teacherId, body.slots);
  }

  // --- entries (conflict-checked) ---
  @Post("entries")
  @RequirePermission(TIMETABLE_PERMISSIONS.TIMETABLE_WRITE)
  createEntry(
    @CurrentPrincipal() p: Principal,
    @Body(new ZodValidationPipe(entrySchema)) body: z.infer<typeof entrySchema>,
  ) {
    return this.timetable.createEntry(p, body);
  }

  @Patch("entries/:id")
  @RequirePermission(TIMETABLE_PERMISSIONS.TIMETABLE_WRITE)
  updateEntry(
    @CurrentPrincipal() p: Principal,
    @Param("id") id: string,
    @Body(new ZodValidationPipe(entryUpdateSchema)) body: z.infer<typeof entryUpdateSchema>,
  ) {
    return this.timetable.updateEntry(p, id, body);
  }

  @Delete("entries/:id")
  @RequirePermission(TIMETABLE_PERMISSIONS.TIMETABLE_WRITE)
  deleteEntry(@CurrentPrincipal() p: Principal, @Param("id") id: string) {
    return this.timetable.deleteEntry(p, id);
  }

  @Get("entries")
  @RequirePermission(TIMETABLE_PERMISSIONS.TIMETABLE_READ)
  listEntries(
    @CurrentPrincipal() p: Principal,
    @Query("classId") classId?: string,
    @Query("teacherId") teacherId?: string,
    @Query("dayOfWeek") dayOfWeek?: string,
  ) {
    const day = dayOfWeek && DAYS_OF_WEEK.includes(dayOfWeek as never) ? (dayOfWeek as never) : undefined;
    return this.timetable.listEntries(p, { classId, teacherId, dayOfWeek: day });
  }

  @Get("classes/:classId")
  @RequirePermission(TIMETABLE_PERMISSIONS.TIMETABLE_READ)
  classTimetable(@CurrentPrincipal() p: Principal, @Param("classId") classId: string): Promise<TimetableEntryDto[]> {
    return this.timetable.getClassTimetable(p, classId);
  }

  /** The grid along whichever axis you ask for: class, TEACHER or ROOM. Scoped the
   *  same way as /entries, so this never widens what a caller can see. */
  @Get("view")
  @RequirePermission(TIMETABLE_PERMISSIONS.TIMETABLE_READ)
  view(
    @CurrentPrincipal() p: Principal,
    @Query("classId") classId?: string,
    @Query("teacherId") teacherId?: string,
    @Query("roomId") roomId?: string,
  ): Promise<TimetableEntryDto[]> {
    return this.timetable.getTimetableView(p, { classId, teacherId, roomId });
  }

  /** Standing teaching load per teacher — assigned vs available periods. The
   *  solver's overload analysis, but of the timetable as it currently stands. */
  @Get("load")
  @RequirePermission(TIMETABLE_PERMISSIONS.TIMETABLE_READ)
  load(@CurrentPrincipal() p: Principal) {
    return this.timetable.getTeacherLoad(p);
  }

  /** Printable landscape grid for a class or a teacher. Audited; reuses the view's
   *  scoping, so nobody can print a week they cannot already see. */
  /** The grid as CSV — one row per lesson. No filter = the whole school (the
   *  view's own scoping decides whether this caller may have that). */
  @Get("export.csv")
  @RequirePermission(TIMETABLE_PERMISSIONS.TIMETABLE_READ)
  async exportCsv(
    @CurrentPrincipal() p: Principal,
    @Res({ passthrough: true }) res: Response,
    @Query("classId") classId?: string,
    @Query("teacherId") teacherId?: string,
    @Query("roomId") roomId?: string,
  ): Promise<StreamableFile> {
    const { csv, filename } = await this.timetable.exportCsv(p, { classId, teacherId, roomId });
    res.set({ "Content-Type": "text/csv", "Content-Disposition": `attachment; filename="${filename}"` });
    return new StreamableFile(Buffer.from(csv, "utf8"));
  }

  @Get("print.pdf")
  @RequirePermission(TIMETABLE_PERMISSIONS.TIMETABLE_READ)
  async print(
    @CurrentPrincipal() p: Principal,
    @Res() res: Response,
    @Query("classId") classId?: string,
    @Query("teacherId") teacherId?: string,
  ) {
    const { buffer, filename } = await this.timetable.timetablePdf(p, { classId, teacherId });
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    res.send(buffer);
  }
}
