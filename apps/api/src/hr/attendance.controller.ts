// =============================================================================
// StaffAttendanceController — register (hr.write/hr.read) + kiosk clock-in (hr.self)
// =============================================================================

import { isoDay } from "../common/calendar-day";
import { hhmm } from "../common/time-of-day";
import { Body, Controller, Delete, Get, Param, Post, Put, Query, RawBodyRequest, Req } from "@nestjs/common";
import type { Request } from "express";
import { z } from "zod";
import { pageNumber } from "../common/status-filter";
import { HR_PERMISSIONS, MODULES } from "@sms/types";
import type {
  AttendanceRegisterDto,
  AttendanceSummaryDto,
  KioskCodeDto,
  KioskConfigDto,
  StaffAttendanceDto,
  StaffAttendanceHistoryDto,
} from "@sms/types";
import { RequireModule } from "../auth/require-module.decorator";
import { Public } from "../auth/public.decorator";
import { RequirePermission } from "../auth/require-permission.decorator";
import { CurrentPrincipal } from "../auth/current-principal.decorator";
import { ZodValidationPipe } from "../common/zod-validation.pipe";
import type { Principal } from "../integrity/integrity.foundation";
import { StaffDayCloseService } from "./staff-day-close.service";
import { JobRunsService } from "../maintenance/job-runs.service";
import { StaffAttendanceService } from "./attendance.service";
import { boundedInt } from "../common/status-filter";

const markSchema = z.object({
  userId: z.string().uuid(),
  date: isoDay,
  status: z.enum(["PRESENT", "LATE", "ABSENT"]),
  note: z.string().max(300).optional(),
});
const kioskSchema = z.object({
  enabled: z.boolean().optional(),
  allowedIps: z.string().max(500).nullish(),
  windowStart: hhmm.optional(),
  windowEnd: hhmm.optional(),
  lateAfter: hhmm.optional(),
  rotateSecret: z.boolean().optional(),
});
const clockInSchema = z.object({ code: z.string().min(4).max(10) });
const deviceSchema = z.object({ name: z.string().min(1).max(120) });
const enrollSchema = z.object({ deviceUserId: z.string().min(1).max(40), userId: z.string().uuid() });
const deviceBatchSchema = z.object({
  timestamp: z.string().min(1),
  events: z.array(z.object({ deviceUserId: z.string().min(1).max(40), at: z.string().min(1) })).max(500),
});

/** First-hop client IP: x-forwarded-for head (nginx/ALB sets it) else socket. */
function clientIp(req: Request): string | null {
  const xff = req.headers["x-forwarded-for"];
  const first = (Array.isArray(xff) ? xff[0] : xff)?.split(",")[0]?.trim();
  return first || req.ip || null;
}

@RequireModule(MODULES.HR)
@Controller("hr/attendance")
export class StaffAttendanceController {
  constructor(
    private readonly attendance: StaffAttendanceService,
    private readonly dayCloseService: StaffDayCloseService,
    private readonly jobRuns: JobRunsService,
  ) {}

  // --- register (Mode A) -------------------------------------------------------
  @Post("mark")
  @RequirePermission(HR_PERMISSIONS.HR_ATTENDANCE_AMEND)
  mark(
    @CurrentPrincipal() p: Principal,
    @Body(new ZodValidationPipe(markSchema)) b: z.infer<typeof markSchema>,
  ): Promise<StaffAttendanceDto | { pendingApproval: true; requestId: string; date: string }> {
    return this.attendance.mark(p, b);
  }

  @Get("register/:date")
  @RequirePermission(HR_PERMISSIONS.HR_ATTENDANCE_READ)
  register(@CurrentPrincipal() p: Principal, @Param("date") date: string): Promise<AttendanceRegisterDto> {
    return this.attendance.register(p, date);
  }

  @Get("summary")
  @RequirePermission(HR_PERMISSIONS.HR_ATTENDANCE_READ)
  /** Both optional — omitted means the school's current month. */
  summary(
    @CurrentPrincipal() p: Principal,
    @Query("year") year?: string,
    @Query("month") month?: string,
  ): Promise<AttendanceSummaryDto> {
    // // GOTCHA: this used to read `Number(year)` and let the SERVICE treat NaN
    // as "not given" — a fix for a 500 on a call with no parameters at all,
    // which closed that hole and opened a quieter one: `?year=abc` reported the
    // CURRENT month under the year the caller asked for. Absent still means
    // absent; unreadable is now a refusal.
    return this.attendance.summary(
      p,
      boundedInt(year, { field: "year", min: 1900, max: 2200 }),
      boundedInt(month, { field: "month", min: 1, max: 12 }),
    );
  }

  @Get("me")
  @RequirePermission(HR_PERMISSIONS.HR_SELF)
  myHistory(@CurrentPrincipal() p: Principal): Promise<StaffAttendanceDto[]> {
    return this.attendance.myHistory(p);
  }

  // --- kiosk (Mode B) ----------------------------------------------------------
  @Get("kiosk")
  @RequirePermission(HR_PERMISSIONS.HR_READ)
  kioskConfig(@CurrentPrincipal() p: Principal): Promise<KioskConfigDto> {
    return this.attendance.kioskConfig(p);
  }

  @Put("kiosk")
  @RequirePermission(HR_PERMISSIONS.HR_WRITE)
  updateKiosk(
    @CurrentPrincipal() p: Principal,
    @Body(new ZodValidationPipe(kioskSchema)) b: z.infer<typeof kioskSchema>,
  ): Promise<KioskConfigDto> {
    return this.attendance.updateKiosk(p, b);
  }

  /**
   * ONE member of staff's record, compiled per month.
   *
   * `hr.attendance.read` — the same gate as the register, because this is the
   * same data about the same people, narrowed to one of them. There was no such
   * read at all: the register showed today, the roll-up showed this month across
   * everybody, and the only per-person view was a person's own.
   */
  @Get("staff/:userId")
  @RequirePermission(HR_PERMISSIONS.HR_ATTENDANCE_READ)
  staffHistory(
    @CurrentPrincipal() p: Principal,
    @Param("userId") userId: string,
    @Query("month") month?: string,
    @Query("page") page?: string,
  ): Promise<StaffAttendanceHistoryDto> {
    // PARSED THROUGH THE SHARED HELPER, not `Number(page)`: a bare Number()
    // turns "abc" into NaN and "-3" into a negative offset, and every other
    // paged read in this API goes through one definition of what a page is.
    return this.attendance.staffHistory(p, userId, { month, page: pageNumber(page) });
  }


  /**
   * The rotating gate-display code — on its OWN narrow permission.
   *
   * It was gated on `hr.read`, so the screen at the gate had to be signed in as
   * somebody who could also read every member of staff's attendance and the
   * month's roll-up. A display in a corridor should open one number and nothing
   * else.
   */
  @Get("kiosk/code")
  @RequirePermission(HR_PERMISSIONS.HR_KIOSK_DISPLAY)
  kioskCode(@CurrentPrincipal() p: Principal): Promise<KioskCodeDto> {
    return this.attendance.kioskCode(p);
  }

  // --- Mode C: biometric devices (hr.write manages; hr.read views) -----------
  /** Register a terminal — the HMAC secret is returned ONCE. */
  @Post("devices")
  @RequirePermission(HR_PERMISSIONS.HR_WRITE)
  registerDevice(
    @CurrentPrincipal() p: Principal,
    @Body(new ZodValidationPipe(deviceSchema)) b: z.infer<typeof deviceSchema>,
  ) {
    return this.attendance.registerDevice(p, b.name);
  }

  @Get("devices")
  @RequirePermission(HR_PERMISSIONS.HR_READ)
  listDevices(@CurrentPrincipal() p: Principal) {
    return this.attendance.listDevices(p);
  }

  @Delete("devices/:id")
  @RequirePermission(HR_PERMISSIONS.HR_WRITE)
  removeDevice(@CurrentPrincipal() p: Principal, @Param("id") id: string) {
    return this.attendance.removeDevice(p, id);
  }

  @Post("enrollments")
  @RequirePermission(HR_PERMISSIONS.HR_WRITE)
  enroll(
    @CurrentPrincipal() p: Principal,
    @Body(new ZodValidationPipe(enrollSchema)) b: z.infer<typeof enrollSchema>,
  ) {
    return this.attendance.enroll(p, b.deviceUserId, b.userId);
  }

  @Get("enrollments")
  @RequirePermission(HR_PERMISSIONS.HR_READ)
  listEnrollments(@CurrentPrincipal() p: Principal) {
    return this.attendance.listEnrollments(p);
  }

  @Delete("enrollments/:id")
  @RequirePermission(HR_PERMISSIONS.HR_WRITE)
  unenroll(@CurrentPrincipal() p: Principal, @Param("id") id: string) {
    return this.attendance.unenroll(p, id);
  }

  /**
   * Close today's register by hand — SCHOOL-SCOPED.
   *
   * Passes the caller's OWN schoolId, so a press here can never reach the fleet.
   * The catalogue declares `scope: "SCHOOL"` and this is the half that enforces
   * it: a declared scope the handler ignores is exactly the defect
   * `a-fleet-sweep-one-school-could-fire` exists for.
   *
   * `force` because the hourly sweep acts only on the school's evening tick, and
   * somebody pressing the button means now.
   */
  @Post("day-close/run")
  @RequirePermission(HR_PERMISSIONS.HR_ATTENDANCE_AMEND)
  dayClose(@CurrentPrincipal() p: Principal) {
    // RECORDED like the scheduled run. A manual press that files no job run is
    // invisible to the operator console, so nobody can tell afterwards whether
    // the day was closed by the timer, by a person, or not at all.
    return this.jobRuns.record("hr.staffDayClose", "MANUAL", () =>
      this.dayCloseService.run({ onlySchoolId: p.schoolId, force: true }),
    );
  }

  /** Staff clock-in with the current display code (hr.self). */
  @Post("clock-in")
  @RequirePermission(HR_PERMISSIONS.HR_SELF)
  clockIn(
    @CurrentPrincipal() p: Principal,
    @Body(new ZodValidationPipe(clockInSchema)) b: z.infer<typeof clockInSchema>,
    @Req() req: Request,
  ): Promise<StaffAttendanceDto> {
    return this.attendance.clockIn(p, b.code, clientIp(req));
  }

  /**
   * Staff clock-OUT with the current display code (hr.self).
   *
   * Same permission and same proof-of-presence as clocking in — a departure is
   * the other half of the same act, not a privileged one.
   */
  @Post("clock-out")
  @RequirePermission(HR_PERMISSIONS.HR_SELF)
  clockOut(
    @CurrentPrincipal() p: Principal,
    @Body(new ZodValidationPipe(clockInSchema)) b: z.infer<typeof clockInSchema>,
    @Req() req: Request,
  ): Promise<StaffAttendanceDto> {
    return this.attendance.clockOut(p, b.code, clientIp(req));
  }
}

// PUBLIC biometric ingestion — its OWN controller at /public/* (outside the HR
// prefix and module gate; same posture as /public/careers). The terminal
// authenticates by HMAC-signing the EXACT raw body with its per-device secret
// (x-device-id + x-device-signature headers); a stale batch timestamp is
// rejected. Fingerprint/face templates never reach this endpoint — events only.
@Controller("public/biometric")
export class PublicBiometricController {
  constructor(private readonly attendance: StaffAttendanceService) {}

  @Public()
  @Post(":slug/events")
  ingest(
    @Param("slug") slug: string,
    @Req() req: RawBodyRequest<Request>,
    @Body(new ZodValidationPipe(deviceBatchSchema)) b: z.infer<typeof deviceBatchSchema>,
  ) {
    const deviceId = (req.headers["x-device-id"] as string | undefined)?.trim();
    const signature = (req.headers["x-device-signature"] as string | undefined)?.trim();
    return this.attendance.ingestDeviceEvents(slug, deviceId, signature, req.rawBody, b);
  }
}
