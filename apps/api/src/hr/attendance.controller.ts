// =============================================================================
// StaffAttendanceController — register (hr.write/hr.read) + kiosk clock-in (hr.self)
// =============================================================================

import { Body, Controller, Delete, Get, Param, Post, Put, Query, RawBodyRequest, Req } from "@nestjs/common";
import type { Request } from "express";
import { z } from "zod";
import { HR_PERMISSIONS, MODULES } from "@sms/types";
import type {
  AttendanceRegisterDto,
  AttendanceSummaryDto,
  KioskCodeDto,
  KioskConfigDto,
  StaffAttendanceDto,
} from "@sms/types";
import { RequireModule } from "../auth/require-module.decorator";
import { Public } from "../auth/public.decorator";
import { RequirePermission } from "../auth/require-permission.decorator";
import { CurrentPrincipal } from "../auth/current-principal.decorator";
import { ZodValidationPipe } from "../common/zod-validation.pipe";
import type { Principal } from "../integrity/integrity.foundation";
import { StaffAttendanceService } from "./attendance.service";

const markSchema = z.object({
  userId: z.string().uuid(),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  status: z.enum(["PRESENT", "LATE", "ABSENT"]),
  note: z.string().max(300).optional(),
});
const kioskSchema = z.object({
  enabled: z.boolean().optional(),
  allowedIps: z.string().max(500).nullish(),
  windowStart: z.string().regex(/^\d{1,2}:\d{2}$/).optional(),
  windowEnd: z.string().regex(/^\d{1,2}:\d{2}$/).optional(),
  lateAfter: z.string().regex(/^\d{1,2}:\d{2}$/).optional(),
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
  constructor(private readonly attendance: StaffAttendanceService) {}

  // --- register (Mode A) -------------------------------------------------------
  @Post("mark")
  @RequirePermission(HR_PERMISSIONS.HR_WRITE)
  mark(
    @CurrentPrincipal() p: Principal,
    @Body(new ZodValidationPipe(markSchema)) b: z.infer<typeof markSchema>,
  ): Promise<StaffAttendanceDto> {
    return this.attendance.mark(p, b);
  }

  @Get("register/:date")
  @RequirePermission(HR_PERMISSIONS.HR_READ)
  register(@CurrentPrincipal() p: Principal, @Param("date") date: string): Promise<AttendanceRegisterDto> {
    return this.attendance.register(p, date);
  }

  @Get("summary")
  @RequirePermission(HR_PERMISSIONS.HR_READ)
  summary(
    @CurrentPrincipal() p: Principal,
    @Query("year") year: string,
    @Query("month") month: string,
  ): Promise<AttendanceSummaryDto> {
    return this.attendance.summary(p, Number(year), Number(month));
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

  /** The rotating gate-display code (staff-operated screen; hr.read). */
  @Get("kiosk/code")
  @RequirePermission(HR_PERMISSIONS.HR_READ)
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
