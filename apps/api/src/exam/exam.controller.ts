import { Body, Controller, Delete, Get, Param, Patch, Post, Query, Res } from "@nestjs/common";
import type { Response } from "express";
import { z } from "zod";
import { EXAM_PERMISSIONS, TIMETABLE_PERMISSIONS } from "@sms/types";
import type { ExamAttendanceDto, ExamDayDto, ExamScheduleDto, ExamSittingDto, ExamSeatDto, InvigilationDto, MyExamDto } from "@sms/types";
import { RequirePermission } from "../auth/require-permission.decorator";
import { CurrentPrincipal } from "../auth/current-principal.decorator";
import { ZodValidationPipe } from "../common/zod-validation.pipe";
import type { Principal } from "../integrity/integrity.foundation";
import { ExamService } from "./exam.service";

const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);
const ymd = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const sittingSchema = z
  .object({
    title: z.string().min(1).max(200),
    subject: z.string().max(120).optional(),
    date: ymd,
    startsAt: hhmm,
    endsAt: hhmm,
    // Either pick a room from the registry (preferred — it carries the capacity)
    // or type a hall for an ad-hoc venue. The service enforces that one is present.
    hall: z.string().min(1).max(120).optional(),
    roomId: z.string().uuid().nullish(),
    capacity: z.number().int().min(0).max(2000).optional(),
    note: z.string().max(500).optional(),
    classId: z.string().uuid().nullish(),
    scheduleId: z.string().uuid().nullish(),
    cbtExamId: z.string().uuid().nullish(),
  })
  .refine((v) => !!v.roomId || !!v.hall?.trim(), { message: "Pick a room or type a hall name" });

/** Every field optional — a PATCH edits only what it names, so a partial body must
 *  not be read as "clear the rest". `.strict()` makes a typo'd key a 400 rather
 *  than a silently ignored no-op edit. */
const sittingPatchSchema = z
  .object({
    title: z.string().min(1).max(200).optional(),
    subject: z.string().max(120).nullish(),
    date: ymd.optional(),
    startsAt: hhmm.optional(),
    endsAt: hhmm.optional(),
    hall: z.string().min(1).max(120).optional(),
    roomId: z.string().uuid().nullish(),
    capacity: z.number().int().min(0).max(2000).optional(),
    note: z.string().max(500).nullish(),
    classId: z.string().uuid().nullish(),
  })
  .strict();
/** PRESENT | ABSENT only — the two things an invigilator can actually observe. */
const examAttendanceSchema = z.object({
  entries: z
    .array(
      z.object({
        studentId: z.string().uuid(),
        status: z.enum(["PRESENT", "ABSENT"]),
        note: z.string().max(300).nullish(),
      }),
    )
    .min(1)
    .max(2000),
});
const scheduleSchema = z.object({ title: z.string().min(1).max(200), termId: z.string().uuid().nullish() });
const seatSchema = z.object({ studentIds: z.array(z.string().uuid()).max(2000).optional(), classId: z.string().uuid().optional() });
const invigSchema = z.object({ staffId: z.string().uuid(), lead: z.boolean().optional() });

@Controller("exams")
export class ExamController {
  constructor(private readonly exams: ExamService) {}

  // --- student / parent / invigilator self views (gated on timetable.read,
  //     which students, parents and staff all hold) ---
  @Get("mine")
  @RequirePermission(TIMETABLE_PERMISSIONS.TIMETABLE_READ)
  myExams(@CurrentPrincipal() p: Principal): Promise<MyExamDto[]> {
    return this.exams.myExams(p);
  }

  @Get("invigilations/mine")
  @RequirePermission(TIMETABLE_PERMISSIONS.TIMETABLE_READ)
  myInvigilations(@CurrentPrincipal() p: Principal): Promise<MyExamDto[]> {
    return this.exams.myInvigilations(p);
  }

  // --- staff management ---
  /** Sittings, narrowed server-side (schedule / single day / range / hall / text). */
  @Get()
  @RequirePermission(EXAM_PERMISSIONS.EXAM_MANAGE)
  list(
    @CurrentPrincipal() p: Principal,
    @Query("scheduleId") scheduleId?: string,
    @Query("date") date?: string,
    @Query("from") from?: string,
    @Query("to") to?: string,
    @Query("hall") hall?: string,
    @Query("q") q?: string,
  ): Promise<ExamSittingDto[]> {
    return this.exams.listSittings(p, { scheduleId, date, from, to, hall, q });
  }

  /** The exam-day board: one date, grouped by hall, warnings precomputed. */
  @Get("day")
  @RequirePermission(EXAM_PERMISSIONS.EXAM_MANAGE)
  day(@CurrentPrincipal() p: Principal, @Query("date") date?: string): Promise<ExamDayDto> {
    // No default here: "today" is a question about the SCHOOL's timezone and
    // the service is what knows it.
    return this.exams.examDay(p, date ? ymd.parse(date) : undefined);
  }

  @Post()
  @RequirePermission(EXAM_PERMISSIONS.EXAM_MANAGE)
  create(
    @CurrentPrincipal() p: Principal,
    @Body(new ZodValidationPipe(sittingSchema)) body: z.infer<typeof sittingSchema>,
  ): Promise<ExamSittingDto> {
    return this.exams.createSitting(p, body);
  }

  /** Edit a sitting IN PLACE — seats and the invigilator roster are preserved.
   *  Declared before the `:id/...` routes below purely for readability; Nest
   *  matches on method + path, so PATCH has no collision with them. */
  @Patch(":id")
  @RequirePermission(EXAM_PERMISSIONS.EXAM_MANAGE)
  update(
    @CurrentPrincipal() p: Principal,
    @Param("id") id: string,
    @Body(new ZodValidationPipe(sittingPatchSchema)) body: z.infer<typeof sittingPatchSchema>,
  ): Promise<ExamSittingDto> {
    return this.exams.updateSitting(p, id, body);
  }

  // --- schedules (maker-checker) + day-of release ---
  @Get("schedules")
  @RequirePermission(EXAM_PERMISSIONS.EXAM_MANAGE)
  schedules(@CurrentPrincipal() p: Principal): Promise<ExamScheduleDto[]> {
    return this.exams.listSchedules(p);
  }

  @Post("schedules")
  @RequirePermission(EXAM_PERMISSIONS.EXAM_MANAGE)
  createSchedule(
    @CurrentPrincipal() p: Principal,
    @Body(new ZodValidationPipe(scheduleSchema)) body: z.infer<typeof scheduleSchema>,
  ): Promise<ExamScheduleDto> {
    return this.exams.createSchedule(p, body);
  }

  /** Submit the whole schedule for head-teacher → principal approval. */
  @Post("schedules/:id/submit")
  @RequirePermission(EXAM_PERMISSIONS.EXAM_MANAGE)
  submitSchedule(@CurrentPrincipal() p: Principal, @Param("id") id: string) {
    return this.exams.requestScheduleApproval(p, id);
  }

  /** Seat every unseated sitting in the schedule from its class roster, on demand.
   *  Idempotent — already-seated sittings are skipped, never renumbered. */
  @Post("schedules/:id/seat")
  @RequirePermission(EXAM_PERMISSIONS.EXAM_MANAGE)
  seatSchedule(@CurrentPrincipal() p: Principal, @Param("id") id: string): Promise<{ seated: number; skipped: number }> {
    return this.exams.seatSchedule(p, id);
  }

  /** Day-of RELEASE (open) an approved CBT-backed sitting — exam.release only. */
  @Post(":id/release")
  @RequirePermission(EXAM_PERMISSIONS.EXAM_RELEASE)
  release(@CurrentPrincipal() p: Principal, @Param("id") id: string) {
    return this.exams.releaseSitting(p, id);
  }

  @Delete(":id")
  @RequirePermission(EXAM_PERMISSIONS.EXAM_MANAGE)
  remove(@CurrentPrincipal() p: Principal, @Param("id") id: string) {
    return this.exams.deleteSitting(p, id);
  }

  @Get(":id/seats")
  @RequirePermission(EXAM_PERMISSIONS.EXAM_MANAGE)
  seats(@CurrentPrincipal() p: Principal, @Param("id") id: string): Promise<ExamSeatDto[]> {
    return this.exams.getSeatPlan(p, id);
  }

  /** The sitting's own register: every seated student with their latest mark.
   *  `status: null` = not yet marked, which is NOT the same as absent. */
  @Get(":id/attendance")
  @RequirePermission(EXAM_PERMISSIONS.EXAM_MANAGE)
  sittingAttendance(@CurrentPrincipal() p: Principal, @Param("id") id: string): Promise<ExamAttendanceDto> {
    return this.exams.getSittingAttendance(p, id);
  }

  /** Mark the sitting's register. APPEND-ONLY — a correction is a new row, and this
   *  never writes the daily class register (a pupil can be in school and miss one
   *  exam). Only seated students can be marked. */
  @Post(":id/attendance")
  @RequirePermission(EXAM_PERMISSIONS.EXAM_MANAGE)
  markSittingAttendance(
    @CurrentPrincipal() p: Principal,
    @Param("id") id: string,
    @Body(new ZodValidationPipe(examAttendanceSchema)) body: z.infer<typeof examAttendanceSchema>,
  ): Promise<ExamAttendanceDto> {
    return this.exams.markSittingAttendance(p, id, body.entries);
  }

  /** The printable hall pack: seating chart + signature column + absentee tally.
   *  Audited — it lists the names of minors sitting a specific exam. */
  @Get(":id/attendance.pdf")
  @RequirePermission(EXAM_PERMISSIONS.EXAM_MANAGE)
  async attendanceSheet(@CurrentPrincipal() p: Principal, @Param("id") id: string, @Res() res: Response) {
    const { buffer, filename } = await this.exams.attendanceSheetPdf(p, id);
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    res.send(buffer);
  }

  /** Seat a list of students, or auto-seat a whole class. */
  @Post(":id/seats")
  @RequirePermission(EXAM_PERMISSIONS.EXAM_MANAGE)
  seat(
    @CurrentPrincipal() p: Principal,
    @Param("id") id: string,
    @Body(new ZodValidationPipe(seatSchema)) body: z.infer<typeof seatSchema>,
  ): Promise<ExamSeatDto[]> {
    if (body.classId) return this.exams.seatClass(p, id, body.classId);
    return this.exams.seat(p, id, body.studentIds ?? []);
  }

  @Get(":id/invigilators")
  @RequirePermission(EXAM_PERMISSIONS.EXAM_MANAGE)
  invigilators(@CurrentPrincipal() p: Principal, @Param("id") id: string): Promise<InvigilationDto[]> {
    return this.exams.getInvigilators(p, id);
  }

  @Post(":id/invigilators")
  @RequirePermission(EXAM_PERMISSIONS.EXAM_MANAGE)
  addInvigilator(
    @CurrentPrincipal() p: Principal,
    @Param("id") id: string,
    @Body(new ZodValidationPipe(invigSchema)) body: z.infer<typeof invigSchema>,
  ): Promise<InvigilationDto> {
    return this.exams.assignInvigilator(p, id, body.staffId, body.lead ?? false);
  }

  @Delete(":id/invigilators/:staffId")
  @RequirePermission(EXAM_PERMISSIONS.EXAM_MANAGE)
  removeInvigilator(@CurrentPrincipal() p: Principal, @Param("id") id: string, @Param("staffId") staffId: string) {
    return this.exams.removeInvigilator(p, id, staffId);
  }
}
