import { Body, Controller, Get, Param, Post, Query } from "@nestjs/common";
import { MODULES } from "@sms/types";
import { RequireModule } from "../auth/require-module.decorator";
import { z } from "zod";
import { ATTENDANCE_PERMISSIONS, ATTENDANCE_STATUSES } from "@sms/types";
import { RequirePermission } from "../auth/require-permission.decorator";
import { CurrentPrincipal } from "../auth/current-principal.decorator";
import { ZodValidationPipe } from "../common/zod-validation.pipe";
import type { Principal } from "../integrity/integrity.foundation";
import { AttendanceService } from "./attendance.service";
import { AttendanceRollupService } from "./attendance-rollup.service";

/** Query-string numbers arrive as strings; coerce and bound them at the boundary. */
const pageSchema = z.coerce.number().int().min(1).max(100_000).optional();

const markSchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  records: z
    .array(
      z.object({
        studentId: z.string().uuid(),
        status: z.enum(ATTENDANCE_STATUSES),
        note: z.string().max(500).nullish(),
      }),
    )
    .min(1),
});

@RequireModule(MODULES.ATTENDANCE)
@Controller()
export class AttendanceController {
  constructor(
    private readonly attendance: AttendanceService,
    private readonly rollup: AttendanceRollupService,
  ) {}

  /** Take/correct a class register for a date. Teacher-of-class scoped. */
  @Post("classes/:classId/attendance")
  @RequirePermission(ATTENDANCE_PERMISSIONS.ATTENDANCE_WRITE)
  mark(
    @CurrentPrincipal() p: Principal,
    @Param("classId") classId: string,
    @Body(new ZodValidationPipe(markSchema)) body: z.infer<typeof markSchema>,
  ) {
    return this.attendance.markAttendance(p, classId, body);
  }

  /** A class register for ?date=YYYY-MM-DD, or recent sessions if omitted. */
  @Get("attendance/term-lock")
  @RequirePermission(ATTENDANCE_PERMISSIONS.ATTENDANCE_READ)
  termLock(@CurrentPrincipal() p: Principal) {
    return this.attendance.getTermLock(p);
  }

  @Get("classes/:classId/attendance")
  @RequirePermission(ATTENDANCE_PERMISSIONS.ATTENDANCE_READ)
  classAttendance(
    @CurrentPrincipal() p: Principal,
    @Param("classId") classId: string,
    @Query("date") date?: string,
  ) {
    return this.attendance.getClassAttendance(p, classId, date);
  }

  /** Roll up every ENDED term that has no rollup yet. Idempotent — a term already
   *  rolled up is skipped, so re-running is free. Ended terms are immutable under
   *  the term lock, which is why this can never produce a stale figure. */
  @Post("attendance/rollup/refresh")
  @RequirePermission(ATTENDANCE_PERMISSIONS.ATTENDANCE_WRITE)
  refreshRollup(@CurrentPrincipal() p: Principal) {
    return this.rollup.refreshEndedTerms(p);
  }

  /** Attendance BY CLASS over a window — the senior-staff overview. Each row says
   *  whether THIS caller may take that class's register, so the UI never offers a
   *  button the API would refuse.
   *
   *  `?termId=` names a term (including one from years ago); an ENDED term is served
   *  from the rollup rather than by scanning its registers. Raw `from`/`to` still
   *  work for an arbitrary window and are always computed live. */
  @Get("attendance/by-class")
  @RequirePermission(ATTENDANCE_PERMISSIONS.ATTENDANCE_READ)
  byClass(
    @CurrentPrincipal() p: Principal,
    @Query("from") from?: string,
    @Query("to") to?: string,
    @Query("termId") termId?: string,
  ) {
    return this.attendance.getClassAttendance_Grouped(p, { from, to, termId });
  }

  /** The school's terms, newest first, flagged with whether each is rolled up.
   *  Feeds the term selector — this is what makes a register from five years ago
   *  reachable at all. */
  @Get("attendance/terms")
  @RequirePermission(ATTENDANCE_PERMISSIONS.ATTENDANCE_READ)
  terms(@CurrentPrincipal() p: Principal) {
    return this.attendance.listTerms(p);
  }

  /** Which of the caller's classes have no register for ?date= (default today).
   *  Teacher -> their classes; whole-school staff -> every class. */
  @Get("attendance/registers")
  @RequirePermission(ATTENDANCE_PERMISSIONS.ATTENDANCE_READ)
  registers(@CurrentPrincipal() p: Principal, @Query("date") date?: string) {
    return this.attendance.getRegisterStatus(p, date);
  }

  /** A student's attendance history, PAGED with the true total. Relationship-scoped
   *  (staff/teacher/parent/self). Was capped at 200 rows — about one school year —
   *  with nothing on screen to say the rest existed. */
  @Get("students/:studentId/attendance")
  @RequirePermission(ATTENDANCE_PERMISSIONS.ATTENDANCE_READ)
  studentAttendance(
    @CurrentPrincipal() p: Principal,
    @Param("studentId") studentId: string,
    @Query("page", new ZodValidationPipe(pageSchema)) page?: number,
    @Query("pageSize", new ZodValidationPipe(pageSchema)) pageSize?: number,
    @Query("from") from?: string,
    @Query("to") to?: string,
  ) {
    return this.attendance.getStudentAttendance(p, studentId, { page, pageSize, from, to });
  }

  /** A student's current-term totals (% present, absences, lates). Same scoping. */
  @Get("students/:studentId/attendance/summary")
  @RequirePermission(ATTENDANCE_PERMISSIONS.ATTENDANCE_READ)
  studentSummary(@CurrentPrincipal() p: Principal, @Param("studentId") studentId: string) {
    return this.attendance.getStudentSummary(p, studentId);
  }
}
