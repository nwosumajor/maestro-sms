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
  constructor(private readonly attendance: AttendanceService) {}

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
  @Get("classes/:classId/attendance")
  @RequirePermission(ATTENDANCE_PERMISSIONS.ATTENDANCE_READ)
  classAttendance(
    @CurrentPrincipal() p: Principal,
    @Param("classId") classId: string,
    @Query("date") date?: string,
  ) {
    return this.attendance.getClassAttendance(p, classId, date);
  }

  /** A student's attendance history. Relationship-scoped (staff/teacher/parent/self). */
  @Get("students/:studentId/attendance")
  @RequirePermission(ATTENDANCE_PERMISSIONS.ATTENDANCE_READ)
  studentAttendance(
    @CurrentPrincipal() p: Principal,
    @Param("studentId") studentId: string,
  ) {
    return this.attendance.getStudentAttendance(p, studentId);
  }
}
