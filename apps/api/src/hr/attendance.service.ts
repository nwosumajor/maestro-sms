// =============================================================================
// StaffAttendanceService — staff attendance register + anti-spoofing clock-in
// =============================================================================
// One unified staff_attendance table across capture modes:
//   ADMIN      — hr.write marks the register (the trusted default; nothing for a
//                remote staff member to spoof).
//   SELF_KIOSK — staff clock in with the ROTATING TOTP code shown on the school's
//                gate display: knowing the current code proves physical presence
//                at the display. The kiosk secret is field-ENCRYPTED and never
//                leaves the server. Off-window rejected; off-allowlist IP is
//                FLAGGED (a signal for human review, never a block/penalty).
//   BIOMETRIC  — future terminal ingestion lands in the same table.
// Corrections are UPDATEs (no hard delete); every mutation audited; staff see
// their OWN history, hr.read sees all. Tenant-isolated (RLS).
// =============================================================================

import { BadRequestException, ConflictException, ForbiddenException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import type {
  AttendanceRegisterDto,
  AttendanceSummaryDto,
  KioskCodeDto,
  KioskConfigDto,
  StaffAttendanceDto,
} from "@sms/types";
import { decryptField, encryptField } from "../foundation/field-crypto";
import { generateSecret, totp, verifyTotp } from "../auth/totp";
import { deriveClockInStatus, inClockInWindow, ipMatchesAllowlist, isFreshTimestamp, verifyDeviceSignature } from "./attendance.util";
import { randomBytes } from "node:crypto";
import {
  AUDIT_LOG_SERVICE,
  TENANT_DATABASE,
  type AuditLogService,
  type Principal,
  type TenantContext,
  type TenantDatabase,
  type TenantTx,
} from "../integrity/integrity.foundation";

const KIOSK_STEP_SEC = 30;
const ZERO = "00000000-0000-0000-0000-000000000000"; // system actor for device events

type MarkRow = {
  id: string;
  userId: string;
  date: Date;
  status: string;
  source: string;
  clockInAt: Date | null;
  flagged: boolean;
  note: string | null;
};

function dayUtc(dateStr: string): Date {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) throw new BadRequestException("date must be YYYY-MM-DD");
  const d = new Date(`${dateStr}T00:00:00.000Z`);
  if (Number.isNaN(d.getTime())) throw new BadRequestException("invalid date");
  return d;
}

@Injectable()
export class StaffAttendanceService {
  constructor(
    @Inject(TENANT_DATABASE) private readonly db: TenantDatabase,
    @Inject(AUDIT_LOG_SERVICE) private readonly audit: AuditLogService,
  ) {}

  private ctx(p: Principal): TenantContext {
    return { schoolId: p.schoolId, userId: p.userId };
  }

  // --- Mode A: the admin-marked register --------------------------------------
  /** Mark (or correct) one staff member's attendance for a day. */
  async mark(
    p: Principal,
    input: { userId: string; date: string; status: "PRESENT" | "LATE" | "ABSENT"; note?: string },
  ): Promise<StaffAttendanceDto> {
    const date = dayUtc(input.date);
    return this.db.runAsTenant(this.ctx(p), async (tx) => {
      const emp = await tx.employee.findFirst({ where: { userId: input.userId, status: "ACTIVE" }, select: { id: true } });
      if (!emp) throw new NotFoundException("Active employee record not found");
      const row = await tx.staffAttendance.upsert({
        where: { userId_date: { userId: input.userId, date } },
        create: {
          schoolId: p.schoolId,
          userId: input.userId,
          date,
          status: input.status,
          source: "ADMIN",
          markedById: p.userId,
          note: (input.note ?? "").trim() || null,
        },
        update: { status: input.status, source: "ADMIN", markedById: p.userId, note: (input.note ?? "").trim() || null },
      });
      await this.audit.record(
        { actorId: p.userId, action: "hr.attendance.mark", entity: "staff_attendance", entityId: row.id, schoolId: p.schoolId, metadata: { userId: input.userId, date: input.date, status: input.status } },
        tx,
      );
      return this.toDto(row, null);
    });
  }

  /** The day's register: every ACTIVE employee, marked or not. */
  async register(p: Principal, dateStr: string): Promise<AttendanceRegisterDto> {
    const date = dayUtc(dateStr);
    return this.db.runAsTenant(this.ctx(p), async (tx) => {
      const employees = await tx.employee.findMany({ where: { status: "ACTIVE" }, select: { userId: true } });
      const users = await tx.user.findMany({
        where: { id: { in: employees.map((e) => e.userId) } },
        select: { id: true, name: true },
      });
      const marks = await tx.staffAttendance.findMany({ where: { date } });
      const markByUser = new Map(marks.map((m) => [m.userId, m]));
      const nameById = new Map(users.map((u) => [u.id, u.name]));
      return {
        date: dateStr,
        rows: employees
          .map((e) => ({
            userId: e.userId,
            userName: nameById.get(e.userId) ?? "Staff",
            mark: markByUser.has(e.userId) ? this.toDto(markByUser.get(e.userId)!, null) : null,
          }))
          .sort((a, b) => a.userName.localeCompare(b.userName)),
      };
    });
  }

  /** Per-staff monthly roll-up (register view + analytics feed). */
  async summary(p: Principal, year: number, month: number): Promise<AttendanceSummaryDto> {
    if (month < 1 || month > 12) throw new BadRequestException("month must be 1–12");
    const from = new Date(Date.UTC(year, month - 1, 1));
    const to = new Date(Date.UTC(year, month, 1));
    return this.db.runAsTenant(this.ctx(p), async (tx) => {
      const marks = await tx.staffAttendance.findMany({ where: { date: { gte: from, lt: to } } });
      const users = await tx.user.findMany({
        where: { id: { in: [...new Set(marks.map((m) => m.userId))] } },
        select: { id: true, name: true },
      });
      const nameById = new Map(users.map((u) => [u.id, u.name]));
      const byUser = new Map<string, { present: number; late: number; absent: number; flagged: number }>();
      for (const m of marks) {
        const r = byUser.get(m.userId) ?? { present: 0, late: 0, absent: 0, flagged: 0 };
        if (m.status === "PRESENT") r.present++;
        else if (m.status === "LATE") r.late++;
        else if (m.status === "ABSENT") r.absent++;
        if (m.flagged) r.flagged++;
        byUser.set(m.userId, r);
      }
      return {
        year,
        month,
        rows: [...byUser.entries()]
          .map(([userId, r]) => ({ userId, userName: nameById.get(userId) ?? "Staff", ...r }))
          .sort((a, b) => a.userName.localeCompare(b.userName)),
      };
    });
  }

  /** My attendance history (staff self-service, most recent first). */
  async myHistory(p: Principal): Promise<StaffAttendanceDto[]> {
    return this.db.runAsTenant(this.ctx(p), async (tx) => {
      const rows = await tx.staffAttendance.findMany({
        where: { userId: p.userId },
        orderBy: { date: "desc" },
        take: 60,
      });
      return rows.map((r) => this.toDto(r, null));
    });
  }

  // --- Mode B: TOTP kiosk clock-in --------------------------------------------
  /** Kiosk config for HR (never includes the secret). */
  async kioskConfig(p: Principal): Promise<KioskConfigDto> {
    return this.db.runAsTenant(this.ctx(p), async (tx) => {
      const k = await tx.attendanceKiosk.findFirst({});
      return {
        enabled: k?.enabled ?? false,
        allowedIps: k?.allowedIps ?? null,
        windowStart: k?.windowStart ?? "06:00",
        windowEnd: k?.windowEnd ?? "10:00",
        lateAfter: k?.lateAfter ?? "08:00",
      };
    });
  }

  /** Create/update the kiosk. `rotateSecret` invalidates all outstanding codes. */
  async updateKiosk(
    p: Principal,
    input: { enabled?: boolean; allowedIps?: string | null; windowStart?: string; windowEnd?: string; lateAfter?: string; rotateSecret?: boolean },
  ): Promise<KioskConfigDto> {
    for (const f of ["windowStart", "windowEnd", "lateAfter"] as const) {
      const v = input[f];
      if (v !== undefined && !/^\d{1,2}:\d{2}$/.test(v)) throw new BadRequestException(`${f} must be HH:MM`);
    }
    return this.db.runAsTenant(this.ctx(p), async (tx) => {
      const existing = await tx.attendanceKiosk.findFirst({});
      const data = {
        ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
        ...(input.allowedIps !== undefined ? { allowedIps: (input.allowedIps ?? "").trim() || null } : {}),
        ...(input.windowStart !== undefined ? { windowStart: input.windowStart } : {}),
        ...(input.windowEnd !== undefined ? { windowEnd: input.windowEnd } : {}),
        ...(input.lateAfter !== undefined ? { lateAfter: input.lateAfter } : {}),
        updatedById: p.userId,
      };
      if (!existing) {
        await tx.attendanceKiosk.create({
          data: { schoolId: p.schoolId, secretEnc: encryptField(generateSecret(), p.schoolId), ...data },
        });
      } else {
        await tx.attendanceKiosk.update({
          where: { id: existing.id },
          data: { ...data, ...(input.rotateSecret ? { secretEnc: encryptField(generateSecret(), p.schoolId) } : {}) },
        });
      }
      await this.audit.record(
        { actorId: p.userId, action: "hr.attendance.kiosk.update", entity: "attendance_kiosk", entityId: p.schoolId, schoolId: p.schoolId, metadata: { rotated: !!input.rotateSecret, enabled: input.enabled } },
        tx,
      );
      return this.kioskConfigFromTx(tx);
    });
  }

  /** The rotating code for the gate display (hr.read — the display device is a
   *  staff-operated screen). Knowing the CURRENT code proves presence at it. */
  async kioskCode(p: Principal): Promise<KioskCodeDto> {
    return this.db.runAsTenant(this.ctx(p), async (tx) => {
      const k = await tx.attendanceKiosk.findFirst({});
      if (!k || !k.enabled) throw new NotFoundException("Clock-in kiosk is not enabled");
      const secret = decryptField(k.secretEnc, p.schoolId);
      const now = Date.now();
      return {
        code: totp(secret, now, KIOSK_STEP_SEC),
        secondsRemaining: KIOSK_STEP_SEC - (Math.floor(now / 1000) % KIOSK_STEP_SEC),
      };
    });
  }

  /** Staff clock-in with the current kiosk code. Window enforced; wrong code
   *  409s; off-allowlist IP records a FLAG (signal). Idempotent per day. */
  async clockIn(p: Principal, code: string, ip: string | null): Promise<StaffAttendanceDto> {
    const now = new Date();
    return this.db.runAsTenant(this.ctx(p), async (tx) => {
      const emp = await tx.employee.findFirst({ where: { userId: p.userId, status: "ACTIVE" }, select: { id: true } });
      if (!emp) throw new BadRequestException("You need an active employment record to clock in");
      const k = await tx.attendanceKiosk.findFirst({});
      if (!k || !k.enabled) throw new NotFoundException("Clock-in kiosk is not enabled");
      if (!inClockInWindow(k.windowStart, k.windowEnd, now)) {
        throw new ConflictException(`Clock-in is open ${k.windowStart}–${k.windowEnd}`);
      }
      const secret = decryptField(k.secretEnc, p.schoolId);
      if (!verifyTotp(secret, (code ?? "").trim(), 1, Date.now(), KIOSK_STEP_SEC)) {
        // A wrong code is itself a signal — audit it (no attendance row).
        await this.audit.record(
          { actorId: p.userId, action: "hr.attendance.clockin.badcode", entity: "attendance_kiosk", entityId: p.schoolId, schoolId: p.schoolId, metadata: { ip } },
          tx,
        );
        throw new ConflictException("That code isn't current — read it off the display and try again");
      }
      const date = dayUtc(now.toISOString().slice(0, 10));
      const existing = await tx.staffAttendance.findFirst({ where: { userId: p.userId, date } });
      if (existing) return this.toDto(existing, null); // already clocked in today
      const flagged = !ipMatchesAllowlist(ip, k.allowedIps);
      const row = await tx.staffAttendance.create({
        data: {
          schoolId: p.schoolId,
          userId: p.userId,
          date,
          status: deriveClockInStatus(k.lateAfter, now),
          source: "SELF_KIOSK",
          markedById: p.userId,
          clockInAt: now,
          ip,
          flagged,
        },
      });
      await this.audit.record(
        { actorId: p.userId, action: "hr.attendance.clockin", entity: "staff_attendance", entityId: row.id, schoolId: p.schoolId, metadata: { status: row.status, flagged, ip } },
        tx,
      );
      return this.toDto(row, null);
    });
  }

  // --- Mode C: biometric terminal ingestion ------------------------------------
  /** Register a terminal. The HMAC secret is returned ONCE (encrypted at rest).
   *  PRIVACY: fingerprint/face templates never enter this system — matching
   *  happens on the device; we store only attendance events. */
  async registerDevice(p: Principal, name: string): Promise<{ id: string; deviceId: string; secret: string }> {
    const clean = (name ?? "").trim();
    if (!clean) throw new BadRequestException("name is required");
    const deviceId = randomBytes(6).toString("hex");
    const secret = randomBytes(32).toString("hex");
    return this.db.runAsTenant(this.ctx(p), async (tx) => {
      const row = await tx.attendanceDevice.create({
        data: { schoolId: p.schoolId, name: clean, deviceId, secretEnc: encryptField(secret, p.schoolId), createdById: p.userId },
      });
      await this.audit.record(
        { actorId: p.userId, action: "hr.attendance.device.register", entity: "attendance_device", entityId: row.id, schoolId: p.schoolId, metadata: { name: clean, deviceId } },
        tx,
      );
      return { id: row.id, deviceId, secret }; // secret shown once — never readable again
    });
  }

  async listDevices(p: Principal): Promise<{ id: string; name: string; deviceId: string; enabled: boolean; lastSeenAt: Date | null }[]> {
    return this.db.runAsTenant(this.ctx(p), async (tx) => {
      const rows = await tx.attendanceDevice.findMany({ orderBy: { createdAt: "asc" } });
      return rows.map((r) => ({ id: r.id, name: r.name, deviceId: r.deviceId, enabled: r.enabled, lastSeenAt: r.lastSeenAt }));
    });
  }

  async removeDevice(p: Principal, id: string): Promise<{ deleted: boolean }> {
    return this.db.runAsTenant(this.ctx(p), async (tx) => {
      const row = await tx.attendanceDevice.findFirst({ where: { id } });
      if (!row) throw new NotFoundException("Device not found");
      await tx.attendanceDevice.delete({ where: { id } });
      await this.audit.record(
        { actorId: p.userId, action: "hr.attendance.device.remove", entity: "attendance_device", entityId: id, schoolId: p.schoolId, metadata: { deviceId: row.deviceId } },
        tx,
      );
      return { deleted: true };
    });
  }

  /** Map a terminal user-code to a staff member (upsert by code). */
  async enroll(p: Principal, deviceUserId: string, userId: string): Promise<{ id: string }> {
    const code = (deviceUserId ?? "").trim();
    if (!code) throw new BadRequestException("deviceUserId is required");
    return this.db.runAsTenant(this.ctx(p), async (tx) => {
      const emp = await tx.employee.findFirst({ where: { userId, status: "ACTIVE" }, select: { id: true } });
      if (!emp) throw new NotFoundException("Active employee record not found");
      const row = await tx.biometricEnrollment.upsert({
        where: { schoolId_deviceUserId: { schoolId: p.schoolId, deviceUserId: code } },
        create: { schoolId: p.schoolId, deviceUserId: code, userId, createdById: p.userId },
        update: { userId, createdById: p.userId },
      });
      await this.audit.record(
        { actorId: p.userId, action: "hr.attendance.biometric.enroll", entity: "biometric_enrollment", entityId: row.id, schoolId: p.schoolId, metadata: { deviceUserId: code, userId } },
        tx,
      );
      return { id: row.id };
    });
  }

  async listEnrollments(p: Principal): Promise<{ id: string; deviceUserId: string; userId: string; userName: string | null }[]> {
    return this.db.runAsTenant(this.ctx(p), async (tx) => {
      const rows = await tx.biometricEnrollment.findMany({ orderBy: { deviceUserId: "asc" } });
      const users = await tx.user.findMany({
        where: { id: { in: rows.map((r) => r.userId) } },
        select: { id: true, name: true },
      });
      const nameById = new Map(users.map((u) => [u.id, u.name]));
      return rows.map((r) => ({ id: r.id, deviceUserId: r.deviceUserId, userId: r.userId, userName: nameById.get(r.userId) ?? null }));
    });
  }

  async unenroll(p: Principal, id: string): Promise<{ deleted: boolean }> {
    return this.db.runAsTenant(this.ctx(p), async (tx) => {
      const row = await tx.biometricEnrollment.findFirst({ where: { id } });
      if (!row) throw new NotFoundException("Enrollment not found");
      await tx.biometricEnrollment.delete({ where: { id } });
      await this.audit.record(
        { actorId: p.userId, action: "hr.attendance.biometric.unenroll", entity: "biometric_enrollment", entityId: id, schoolId: p.schoolId, metadata: { deviceUserId: row.deviceUserId } },
        tx,
      );
      return { deleted: true };
    });
  }

  /** PUBLIC device batch ingestion. The terminal HMAC-signs the EXACT raw body
   *  with its per-device secret; a stale batch timestamp is rejected (replay).
   *  Each event lands as a staff_attendance row (source BIOMETRIC); an existing
   *  mark for the day wins (idempotent). Unknown user-codes are skipped and
   *  counted — a device can never create staff. */
  async ingestDeviceEvents(
    slug: string,
    deviceId: string | undefined,
    signature: string | undefined,
    rawBody: Buffer | undefined,
    body: { timestamp: string; events: { deviceUserId: string; at: string }[] },
  ): Promise<{ accepted: number; alreadyMarked: number; unknown: number }> {
    const school = await this.db.runAsTenant<{ id: string } | null>(
      { schoolId: ZERO, userId: ZERO },
      (tx) => tx.school.findFirst({ where: { slug, status: "ACTIVE" }, select: { id: true } }),
    );
    if (!school) throw new NotFoundException("School not found");
    return this.db.runAsTenant({ schoolId: school.id, userId: ZERO }, async (tx) => {
      const device = deviceId ? await tx.attendanceDevice.findFirst({ where: { deviceId, enabled: true } }) : null;
      if (!device) throw new NotFoundException("Unknown or disabled device");
      const secret = decryptField(device.secretEnc, school.id);
      if (!verifyDeviceSignature(rawBody, signature, secret)) {
        throw new ForbiddenException("Bad device signature");
      }
      if (!isFreshTimestamp(body.timestamp)) {
        throw new ConflictException("Stale batch timestamp (replay guard) — sync the device clock");
      }
      const kiosk = await tx.attendanceKiosk.findFirst({});
      const lateAfter = kiosk?.lateAfter ?? "08:00";
      const codes = [...new Set(body.events.map((e) => e.deviceUserId))];
      const maps = await tx.biometricEnrollment.findMany({ where: { deviceUserId: { in: codes } } });
      const userByCode = new Map(maps.map((m) => [m.deviceUserId, m.userId]));
      let accepted = 0;
      let alreadyMarked = 0;
      let unknown = 0;
      for (const ev of body.events) {
        const userId = userByCode.get(ev.deviceUserId);
        if (!userId) {
          unknown++;
          continue;
        }
        const at = new Date(ev.at);
        if (Number.isNaN(at.getTime())) {
          unknown++;
          continue;
        }
        const date = new Date(`${at.toISOString().slice(0, 10)}T00:00:00.000Z`);
        const existing = await tx.staffAttendance.findFirst({ where: { userId, date }, select: { id: true } });
        if (existing) {
          alreadyMarked++;
          continue;
        }
        await tx.staffAttendance.create({
          data: {
            schoolId: school.id,
            userId,
            date,
            status: deriveClockInStatus(lateAfter, at),
            source: "BIOMETRIC",
            markedById: ZERO,
            clockInAt: at,
          },
        });
        accepted++;
      }
      await tx.attendanceDevice.update({ where: { id: device.id }, data: { lastSeenAt: new Date() } });
      return { accepted, alreadyMarked, unknown };
    });
  }

  private async kioskConfigFromTx(tx: TenantTx): Promise<KioskConfigDto> {
    const k = await tx.attendanceKiosk.findFirst({});
    return {
      enabled: k?.enabled ?? false,
      allowedIps: k?.allowedIps ?? null,
      windowStart: k?.windowStart ?? "06:00",
      windowEnd: k?.windowEnd ?? "10:00",
      lateAfter: k?.lateAfter ?? "08:00",
    };
  }

  private toDto(r: MarkRow, userName: string | null): StaffAttendanceDto {
    return {
      id: r.id,
      userId: r.userId,
      userName,
      date: r.date,
      status: r.status as StaffAttendanceDto["status"],
      source: r.source as StaffAttendanceDto["source"],
      clockInAt: r.clockInAt,
      flagged: r.flagged,
      note: r.note,
    };
  }
}
