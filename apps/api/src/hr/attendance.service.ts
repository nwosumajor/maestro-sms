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
//   BIOMETRIC  — HMAC-signed terminal batches land in the same table.
//   SYSTEM     — the day-close sweep, which is what records an absence nobody
//                marked and an authorised absence nobody would have.
//
// A DAY IS A SPAN, NOT A STAMP. Every scan is appended to `staff_attendance_event`
// and the day row is a PROJECTION of it — first IN, last OUT. It used to be
// write-once on the first scan, so a gate terminal's departure events were counted
// "already marked" and discarded: the data was arriving and being thrown away, and
// no hours could be derived from what was kept.
//
// Corrections are UPDATEs (no hard delete) and never touch the event log — an
// amendment must not rewrite the scan it contradicts. Every mutation audited;
// staff see their OWN history, hr.read sees all. Tenant-isolated (RLS).
// =============================================================================

import { isIsoDay } from "../common/calendar-day";
import { isHhmm, normaliseHhmm } from "../common/time-of-day";
import { BadRequestException, ConflictException, ForbiddenException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { SYSTEM_ACTOR_ID } from "../billing/billing.constants";
import { Prisma } from "@sms/db";
import { schoolToday, STAFF_ATTENDANCE_AMENDMENT_CHAIN, STAFF_ATTENDANCE_AMEND_WINDOW_DAYS } from "@sms/types";
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
import { SchoolRegionService } from "../foundation/school-region.service";
import { WorkflowService } from "../workflow/workflow.service";
import { WorkflowHooksService } from "../workflow/workflow-hooks.service";

const KIOSK_STEP_SEC = 30;
const ZERO = "00000000-0000-0000-0000-000000000000"; // system actor for device events

type MarkRow = {
  id: string;
  userId: string;
  date: Date;
  status: string;
  source: string;
  clockInAt: Date | null;
  clockOutAt: Date | null;
  flagged: boolean;
  note: string | null;
};

function dayUtc(dateStr: string): Date {
  if (!isIsoDay(dateStr)) throw new BadRequestException("date must be YYYY-MM-DD");
  const d = new Date(`${dateStr}T00:00:00.000Z`);
  if (Number.isNaN(d.getTime())) throw new BadRequestException("invalid date");
  return d;
}

@Injectable()
export class StaffAttendanceService {
  constructor(
    @Inject(TENANT_DATABASE) private readonly db: TenantDatabase,
    @Inject(AUDIT_LOG_SERVICE) private readonly audit: AuditLogService,
    private readonly region: SchoolRegionService,
    private readonly workflow: WorkflowService,
    hooks: WorkflowHooksService,
  ) {
    // Maker-checker reactor: a SENIOR holder of `hr.attendance.amend.review` (a
    // different person from whoever raised it, engine-enforced) approves a
    // correction older than the window, and the mark is applied in the SAME
    // tenant transaction as the transition — so an approval can never be
    // recorded without the change it approves.
    hooks.onFinalized(async (tx, req) => {
      if (req.type !== "STAFF_ATTENDANCE_AMENDMENT" || req.state !== "APPROVED") return;
      const pl = req.payload as { userId?: string; date?: string; status?: string; note?: string | null } | null;
      if (!pl?.userId || !pl.date || !pl.status) return;
      const date = dayUtc(pl.date);
      // The employment record is re-asked HERE because approval happens LATER:
      // somebody can leave between raising a correction and it being approved,
      // and writing attendance for a person who is no longer staff files a
      // record nobody owns.
      const emp = await tx.employee.findFirst({ where: { userId: pl.userId, status: "ACTIVE" }, select: { id: true } });
      if (!emp) return;
      await tx.staffAttendance.upsert({
        where: { userId_date: { userId: pl.userId, date } },
        create: {
          schoolId: req.schoolId,
          userId: pl.userId,
          date,
          status: pl.status,
          source: "ADMIN",
          markedById: req.initiatorId,
          note: (pl.note ?? "").trim() || null,
        },
        update: { status: pl.status, source: "ADMIN", markedById: req.initiatorId, note: (pl.note ?? "").trim() || null },
      });
      await this.audit.record(
        {
          actorId: req.initiatorId,
          action: "hr.attendance.mark.approved",
          entity: "staff_attendance",
          entityId: pl.userId,
          schoolId: req.schoolId,
          metadata: { date: pl.date, status: pl.status, requestId: req.id },
        },
        tx,
      );
    });
  }

  private ctx(p: Principal): TenantContext {
    return { schoolId: p.schoolId, userId: p.userId };
  }

  /**
   * Record ONE scan and re-project the day from the log — the single path every
   * capture mode writes through.
   *
   * The projection rule, stated once so the kiosk and the terminals cannot
   * disagree about it: the day's `clockInAt` is the EARLIEST event and
   * `clockOutAt` the LATEST, and a departure only counts when it is strictly
   * after the arrival. A single scan is an arrival with no recorded departure —
   * a real state, so nothing here invents a zero-length day.
   *
   * Derived from the LOG rather than from the row it is updating, because
   * terminals batch and retry: events do not always arrive in time order, and
   * re-reading means the answer never depends on delivery order.
   */
  private async recordEvent(
    tx: TenantTx,
    input: {
      schoolId: string;
      userId: string;
      date: Date;
      at: Date;
      kind?: "IN" | "OUT";
      source: string;
      deviceId?: string | null;
      ip?: string | null;
    },
  ): Promise<{ clockInAt: Date; clockOutAt: Date | null }> {
    await tx.staffAttendanceEvent.create({
      data: {
        schoolId: input.schoolId,
        userId: input.userId,
        date: input.date,
        kind: input.kind ?? "IN",
        at: input.at,
        source: input.source,
        deviceId: input.deviceId ?? null,
        ip: input.ip ?? null,
      },
    });
    const events = (await tx.staffAttendanceEvent.findMany({
      where: { userId: input.userId, date: input.date },
      select: { at: true },
      orderBy: { at: "asc" },
    })) as Array<{ at: Date }>;
    const first = events[0]!.at;
    const last = events[events.length - 1]!.at;
    return { clockInAt: first, clockOutAt: last.getTime() > first.getTime() ? last : null };
  }

  // --- Mode A: the admin-marked register --------------------------------------
  /** Mark (or correct) one staff member's attendance for a day. */
  async mark(
    p: Principal,
    input: { userId: string; date: string; status: "PRESENT" | "LATE" | "ABSENT" | "ON_LEAVE"; note?: string },
  ): Promise<StaffAttendanceDto | { pendingApproval: true; requestId: string; date: string }> {
    const date = dayUtc(input.date);
    // NOBODY MARKS THEMSELVES. This was a plain upsert on any `userId`, so every
    // holder of the permission could write or rewrite their OWN attendance for
    // any date — the one record later read back as evidence about them. Refused
    // outright rather than flagged: there is no legitimate case for it, and a
    // signal nobody reviews is not a control.
    if (input.userId === p.userId) {
      throw new ForbiddenException(
        "You cannot mark your own attendance — ask another attendance approver to record it.",
      );
    }
    // PAST THE WINDOW IT NEEDS A SECOND SIGNATURE. A correction made while the
    // week is live is ordinary administration; one made long afterwards is a
    // claim about the past, and this record decides lateness conversations and
    // is cited in disciplinary files. The same seven days, and the same
    // maker-checker shape, as amending a PUPIL register.
    const { timezone } = await this.region.forSchool(p.schoolId);
    // The SCHOOL's day: deciding the age of a correction in UTC puts a school
    // west of UTC a day out on every boundary.
    const ageDays = Math.floor((schoolToday(timezone).getTime() - date.getTime()) / 86_400_000);
    if (ageDays > STAFF_ATTENDANCE_AMEND_WINDOW_DAYS) {
      // Checked BEFORE raising, so an amendment naming somebody who is not staff
      // here is refused now rather than after a reviewer's time.
      await this.db.runAsTenant(this.ctx(p), async (tx) => {
        const emp = await tx.employee.findFirst({ where: { userId: input.userId, status: "ACTIVE" }, select: { id: true } });
        if (!emp) throw new NotFoundException("Active employee record not found");
      });
      // WHO, AND TO WHAT. The inbox renders the payload's `summary` and nothing
      // else, and "Staff attendance amendment — 2026-06-01" names neither the
      // person nor the change: an approver cannot countersign a claim about
      // somebody's attendance record from a date alone, and this record is cited
      // in disciplinary files.
      const subject = await this.db.runAsTenant(this.ctx(p), (tx) =>
        tx.user.findFirst({ where: { id: input.userId }, select: { name: true } }),
      );
      const who = (subject as { name?: string } | null)?.name ?? "a member of staff";
      const summary =
        `Change ${who}'s attendance on ${input.date} to ${input.status.toLowerCase().replace("_", " ")}` +
        `${input.note?.trim() ? ` — ${input.note.trim()}` : ""}.`;
      const req = (await this.workflow.createRequest(p, {
        type: "STAFF_ATTENDANCE_AMENDMENT",
        title: `Staff attendance amendment — ${who}, ${input.date}`,
        payload: { summary, userId: input.userId, date: input.date, status: input.status, note: input.note ?? null },
        stages: [...STAFF_ATTENDANCE_AMENDMENT_CHAIN],
      })) as { id: string };
      await this.workflow.submit(p, req.id);
      return { pendingApproval: true as const, requestId: req.id, date: input.date };
    }
    return this.applyMark(p, input);
  }

  /** The write itself, shared by the direct path and the approved amendment. */
  private async applyMark(
    p: Principal,
    input: { userId: string; date: string; status: string; note?: string | null },
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
  /**
   * The month's staff attendance, per person.
   *
   * TWO THINGS THIS GOT WRONG, and they compounded:
   *
   * `year` was never validated at all, and the month guard — `month < 1 ||
   * month > 12` — DOES NOT CATCH NaN, because every comparison with NaN is
   * false. So a guard that reads as complete waved through the one value that
   * breaks everything downstream: `Date.UTC(NaN, NaN, 1)` is an Invalid Date,
   * and Prisma answered with a 500. Calling the endpoint with no parameters at
   * all — which is what any first look at it does — crashed it.
   *
   * Omitting them now means THIS MONTH rather than an error, because that is
   * what someone asking for "the attendance summary" wants. It is the school's
   * month: a report generated at 9pm in Lagos on the 1st must not be January's
   * because the server is still in December.
   */
  async summary(p: Principal, year?: number, month?: number): Promise<AttendanceSummaryDto> {
    const { timezone } = await this.region.forSchool(p.schoolId);
    const today = schoolToday(timezone);
    const y = year === undefined || Number.isNaN(year) ? today.getUTCFullYear() : year;
    const m = month === undefined || Number.isNaN(month) ? today.getUTCMonth() + 1 : month;
    // Number.isInteger is false for NaN, so this catches what the range check
    // could not.
    if (!Number.isInteger(m) || m < 1 || m > 12) throw new BadRequestException("month must be a whole number from 1 to 12");
    if (!Number.isInteger(y) || y < 2000 || y > 2200) throw new BadRequestException("year must be a whole number");
    const from = new Date(Date.UTC(y, m - 1, 1));
    const to = new Date(Date.UTC(y, m, 1));
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
        year: y,
        month: m,
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
    // THE SERVICE RE-CHECKS, and with the SAME rule as the boundary. Both
    // copies used to accept `25:99`, and the readers then disagreed about what
    // to do with it: `deriveClockInStatus` fails OPEN (everyone PRESENT, so
    // nobody is ever late) and `inClockInWindow` fails CLOSED (nobody can clock
    // in). A value that should never have been stored is what makes two
    // sensible fail-safes point in opposite directions.
    for (const f of ["windowStart", "windowEnd", "lateAfter"] as const) {
      const v = input[f];
      if (v !== undefined && !isHhmm(v)) {
        throw new BadRequestException(`${f} must be a time of day as HH:MM (00:00–23:59)`);
      }
    }
    return this.db.runAsTenant(this.ctx(p), async (tx) => {
      const existing = await tx.attendanceKiosk.findFirst({});
      const data = {
        ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
        ...(input.allowedIps !== undefined ? { allowedIps: (input.allowedIps ?? "").trim() || null } : {}),
        ...(input.windowStart !== undefined ? { windowStart: normaliseHhmm(input.windowStart) } : {}),
        ...(input.windowEnd !== undefined ? { windowEnd: normaliseHhmm(input.windowEnd) } : {}),
        ...(input.lateAfter !== undefined ? { lateAfter: normaliseHhmm(input.lateAfter) } : {}),
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
      // Needed BEFORE the window check: the window is the school's wall clock.
      const { timezone } = await this.region.inTx(tx, p.schoolId);
      if (!inClockInWindow(k.windowStart, k.windowEnd, now, timezone)) {
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
      // The SCHOOL's day. The PUPIL register was moved onto this and the STAFF
      // register was not — the same failure the pupil one was fixed for: a
      // Toronto member of staff clocking in for an evening duty is already on
      // the server's tomorrow, so the shift filed against the wrong day and the
      // "already clocked in today" check looked at the wrong day too.
      const date = await this.region.todayInTx(tx, p.schoolId);
      const existing = await tx.staffAttendance.findFirst({ where: { userId: p.userId, date } });
      if (existing) return this.toDto(existing, null); // already clocked in today
      const flagged = !ipMatchesAllowlist(ip, k.allowedIps);
      const span = await this.recordEvent(tx, {
        schoolId: p.schoolId,
        userId: p.userId,
        date,
        at: now,
        kind: "IN",
        source: "SELF_KIOSK",
        ip,
      });
      const row = await tx.staffAttendance.create({
        data: {
          schoolId: p.schoolId,
          userId: p.userId,
          date,
          status: deriveClockInStatus(k.lateAfter, now, timezone),
          source: "SELF_KIOSK",
          markedById: p.userId,
          clockInAt: span.clockInAt,
          clockOutAt: span.clockOutAt,
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

  /**
   * Clock OUT — the other half of the day, which did not exist.
   *
   * DELIBERATELY NOT WINDOWED. Clock-IN is refused outside the kiosk window
   * because an arrival outside it is what the window exists to catch; applying
   * the same window to a departure would refuse everybody who stays past it,
   * which is most of the staff on most days. The code must still be current, so
   * it is still proof of presence at the display.
   *
   * REFUSES when there is no arrival to close rather than inventing one: that
   * would file a full day for somebody who never clocked in. The refusal says
   * which, because "cannot clock out" on its own sends somebody to the office.
   *
   * Clocking out twice is not an error — it moves the departure later, which is
   * what actually happened.
   */
  async clockOut(p: Principal, code: string, ip: string | null): Promise<StaffAttendanceDto> {
    const now = new Date();
    return this.db.runAsTenant(this.ctx(p), async (tx) => {
      const k = await tx.attendanceKiosk.findFirst({});
      if (!k || !k.enabled) throw new NotFoundException("Clock-in kiosk is not enabled");
      const secret = decryptField(k.secretEnc, p.schoolId);
      if (!verifyTotp(secret, (code ?? "").trim(), 1, Date.now(), KIOSK_STEP_SEC)) {
        await this.audit.record(
          { actorId: p.userId, action: "hr.attendance.clockout.badcode", entity: "attendance_kiosk", entityId: p.schoolId, schoolId: p.schoolId, metadata: { ip } },
          tx,
        );
        throw new ConflictException("That code isn't current — read it off the display and try again");
      }
      const date = await this.region.todayInTx(tx, p.schoolId);
      const existing = (await tx.staffAttendance.findFirst({ where: { userId: p.userId, date } })) as MarkRow | null;
      if (!existing || !existing.clockInAt) {
        throw new ConflictException("You have not clocked in today, so there is nothing to clock out of");
      }
      const span = await this.recordEvent(tx, {
        schoolId: p.schoolId,
        userId: p.userId,
        date,
        at: now,
        kind: "OUT",
        source: "SELF_KIOSK",
        ip,
      });
      const row = (await tx.staffAttendance.update({
        where: { id: existing.id },
        // The STATUS is not recomputed: lateness is a fact about the arrival and
        // nothing about leaving should change it.
        data: { clockOutAt: span.clockOutAt },
      })) as MarkRow;
      await this.audit.record(
        { actorId: p.userId, action: "hr.attendance.clockout", entity: "staff_attendance", entityId: row.id, schoolId: p.schoolId, metadata: { ip } },
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
      (tx) => tx.school.findFirst({ where: { slug, status: "ACTIVE", isPlatform: false }, select: { id: true } }),
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
      const { timezone } = await this.region.inTx(tx, school.id);
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
        // The SCHOOL's day containing this event, not the server's UTC day. The
        // kiosk path was corrected for exactly this and its sibling here was
        // not: a Singapore terminal reporting an 07:00 local arrival is 23:00
        // UTC the day BEFORE, so almost every clock-in filed against yesterday —
        // where the (userId, date) idempotency check would find yesterday's real
        // row, count the event "already marked", and drop it. The day itself
        // then had no record at all.
        const date = schoolToday(timezone, at);
        const existing = (await tx.staffAttendance.findFirst({
          where: { userId, date },
          select: { id: true, clockInAt: true },
        })) as { id: string; clockInAt: Date | null } | null;
        // EVERY SCAN IS KEPT. This counted an existing row as `alreadyMarked`
        // and DROPPED the event — so a terminal's departure scans, which is most
        // of what it sends after the morning, went in the bin, and the one
        // feature that needed them could not be built from data the device was
        // already sending on a signed, audited endpoint.
        const span = await this.recordEvent(tx, {
          schoolId: school.id,
          userId,
          date,
          at,
          source: "BIOMETRIC",
          deviceId: device.id,
        });
        if (existing) {
          // A later scan closes the day; an earlier one corrects the arrival.
          await tx.staffAttendance.update({
            where: { id: existing.id },
            data: { clockInAt: span.clockInAt, clockOutAt: span.clockOutAt },
          });
          // Counted as ACCEPTED because it was: the event is on the log and the
          // day now reflects it. Reporting it as "already marked" is what made a
          // device look listened to while its data was discarded.
          accepted++;
          continue;
        }
        try {
          await tx.staffAttendance.create({
            data: {
              schoolId: school.id,
              userId,
              date,
              status: deriveClockInStatus(lateAfter, at, timezone),
              source: "BIOMETRIC",
              markedById: ZERO,
              clockInAt: span.clockInAt,
              clockOutAt: span.clockOutAt,
            },
          });
          accepted++;
        } catch (e) {
          // ONE DUPLICATE MUST NOT DISCARD THE WHOLE BATCH.
          //
          // The `findFirst` above is a read and `(userId, date)` is UNIQUE, so
          // two readers reporting the same person at once — a gate terminal and
          // a staffroom one, or a device retrying while its first request is
          // still in flight — both find nothing and both insert. The loser gets
          // P2002.
          //
          // And the whole batch is ONE transaction, so that P2002 rolled back
          // every OTHER event in it: a morning's clock-ins discarded because two
          // terminals saw one person. A device that does not retry loses them
          // silently.
          //
          // A duplicate is precisely the case the read above was checking for,
          // so it is counted the same way and the batch continues.
          if (!(e instanceof Prisma.PrismaClientKnownRequestError) || e.code !== "P2002") throw e;
          alreadyMarked++;
        }
      }
      await tx.attendanceDevice.update({ where: { id: device.id }, data: { lastSeenAt: new Date() } });
      // A MACHINE WRITING ATTENDANCE RECORDS ABOUT PEOPLE LEAVES A TRAIL.
      //
      // Every other write in this service is audited — the kiosk clock-in, the
      // admin mark, the corrections. This path creates the SAME
      // `staff_attendance` rows, over a PUBLIC endpoint, on the say-so of a
      // device, and recorded nothing. So a terminal with a stale clock, a
      // mis-mapped enrolment or a leaked secret produced attendance for real
      // members of staff with no trace of which device claimed what — and staff
      // attendance is read for lateness and feeds pay decisions.
      //
      // ONE ENTRY PER BATCH, not per event. A gate terminal posts continuously;
      // an audit row per clock-in would bury the log it is meant to make
      // readable, and the batch is the unit somebody would actually investigate.
      // The counts are the useful part — `unknown` climbing is a device whose
      // enrolments have drifted, which nothing else surfaces.
      //
      // SYSTEM actor, because there is no user: the caller is a device, and
      // naming it is what the metadata is for.
      await this.audit.record(
        {
          actorId: SYSTEM_ACTOR_ID,
          action: "hr.attendance.device.ingest",
          entity: "attendance_device",
          entityId: device.id,
          schoolId: school.id,
          metadata: { deviceId: device.deviceId, accepted, alreadyMarked, unknown, events: body.events.length },
        },
        tx,
      );
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
      clockOutAt: r.clockOutAt,
      // COMPUTED ONCE, on the server: three screens and a payslip each
      // subtracting two timestamps is three chances to round differently. A day
      // with no recorded departure is NULL, not 0 — "we do not know when they
      // left" and "they were here for no time" are different facts.
      minutesOnSite:
        r.clockInAt && r.clockOutAt
          ? Math.max(0, Math.round((r.clockOutAt.getTime() - r.clockInAt.getTime()) / 60_000))
          : null,
      flagged: r.flagged,
      note: r.note,
    };
  }
}
