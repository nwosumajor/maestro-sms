// =============================================================================
// Member scan lookup
// =============================================================================
// Resolves a SCANNED ID-card code (the member's global `uniqueId`, encoded in
// the card QR) to a member of the SCANNER's OWN school — for library, attendance,
// exam-hall and gate desks.
//
// SECURITY:
//  * TENANT-SCOPED. The lookup runs inside runAsTenant, so RLS confines it to the
//    caller's school. A uniqueId that belongs to ANOTHER school resolves to
//    nothing and returns 404 — never 403 — so a scanner cannot probe whether a
//    code exists elsewhere on the platform (Golden Rule: no cross-tenant
//    existence disclosure).
//  * ROSTER-LEVEL ONLY. Returns name, role, admission number, class and account
//    status — the same information the scanning staff already see on a class
//    list. NEVER medical records or other sensitive PII.
//  * AUDITED. Every scan is logged (who scanned which member).
//  * PERMISSION-GATED at the controller with `member.scan`.
// =============================================================================
import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import type {
  MemberScanDto,
  ScanEventDto,
  ScanPurpose,
  ScanRecordResultDto,
} from "@sms/types";
import { isScanPurpose, schoolToday } from "@sms/types";

/** A movement log is read to answer a question, not to be scrolled. Bounded on
 *  the largest table the platform stores. */
const SCAN_HISTORY_CAP = 200;
import { randomUUID } from "node:crypto";
import { registerClosedReason } from "../attendance/register-window";
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

@Injectable()
export class MemberScanService {
  constructor(
    @Inject(TENANT_DATABASE) private readonly db: TenantDatabase,
    @Inject(AUDIT_LOG_SERVICE) private readonly audit: AuditLogService,
    private readonly region: SchoolRegionService,
  ) {}

  private ctx(p: Principal): TenantContext {
    return { schoolId: p.schoolId, userId: p.userId };
  }

  /** Resolve a scanned code to a member of the caller's school, or 404. */
  async resolve(p: Principal, rawCode: string): Promise<MemberScanDto> {
    return this.db.runAsTenant(this.ctx(p), (tx) =>
      this.resolveInTx(tx, p, rawCode, true),
    );
  }

  /**
   * RECORD an action for a scanned member: writes an append-only scan_event and,
   * for CHECK_IN of a student, marks them present in today's class register.
   * Same tenant-scoping and audit as resolve().
   */
  async record(
    p: Principal,
    rawCode: string,
    purpose: ScanPurpose,
    note: string | null,
  ): Promise<ScanRecordResultDto> {
    return this.db.runAsTenant(this.ctx(p), async (tx) => {
      const member = await this.resolveInTx(tx, p, rawCode, false);

      await tx.scanEvent.create({
        data: {
          schoolId: p.schoolId,
          memberId: member.userId,
          scannedById: p.userId,
          purpose,
          note: note?.trim() || null,
        },
      });

      let attendanceMarkedClass: string | null = null;
      let attendanceNote: string | null = null;

      // CHECK_IN of a STUDENT marks them present for the day. A central scan desk
      // is a deliberate, authorised check-in point (member.scan gated) — hence
      // this bypasses the per-class teacher restriction; takenById records who.
      if (purpose === "CHECK_IN") {
        if (member.role !== "student") {
          attendanceNote =
            "Not a student — movement recorded, no register marked.";
        } else {
          const enrolment = await tx.enrollment.findFirst({
            where: { studentId: member.userId, status: "ACTIVE" },
            select: { classId: true, class: { select: { name: true } } },
          });
          if (!enrolment) {
            attendanceNote = "No active class — attendance not marked.";
          } else {
            // The SCHOOL's calendar day. A gate scan at 07:30 in Singapore is
            // 23:30 the previous day in UTC — it was marking pupils present for
            // yesterday, on the one record that says who was physically there.
            const today = await this.region.todayInTx(tx, p.schoolId);
            // IS TODAY A DAY A REGISTER MAY BE TAKEN AT ALL?
            //
            // The register screen asks this on two adjacent lines and the scan
            // desk asked neither, so a gate scan wrote a register on a declared
            // holiday, and on a day outside the current term — both of which
            // `markAttendance` refuses outright.
            //
            // RECORDED, NOT REFUSED. The movement is the thing a gate terminal
            // exists to capture and it must survive whatever the calendar says;
            // the note explains why no register was marked, in the same shape as
            // the "Not a student" and "No active class" arms above.
            const closed = await registerClosedReason(tx, today, today);
            if (closed) {
              attendanceNote = `${closed.reason} Movement recorded.`;
            } else {
              const session = await tx.attendanceSession.upsert({
                where: {
                  classId_date: { classId: enrolment.classId, date: today },
                },
                update: {},
                create: {
                  schoolId: p.schoolId,
                  classId: enrolment.classId,
                  date: today,
                  takenById: p.userId,
                },
                select: { id: true },
              });
              // `date` IS NOT OPTIONAL HERE. attendance_record is RANGE-partitioned
              // on it, so Postgres forces the partition key into the unique
              // constraint: the target is (sessionId, studentId, date). This upsert
              // was a copy of the register's own, named neither, and every student
              // check-in failed 42P10 — inside runAsTenant, so the scan_event and
              // the audit row rolled back with it and the desk recorded nothing.
              await tx.$executeRaw`
              INSERT INTO "attendance_record" ("id","schoolId","sessionId","studentId","status","note","date","createdAt","updatedAt")
              VALUES (${randomUUID()}::uuid, ${p.schoolId}::uuid, ${session.id}::uuid, ${member.userId}::uuid, 'PRESENT'::"AttendanceStatus", 'scan check-in', ${today}::date, now(), now())
              ON CONFLICT ("sessionId","studentId","date")
              DO UPDATE SET "status" = 'PRESENT', "updatedAt" = now()
            `;
              attendanceMarkedClass = enrolment.class?.name ?? null;
            }
          }
        }
      }

      await this.audit.record(
        {
          actorId: p.userId,
          action: "member.scan.record",
          entity: "scan_event",
          entityId: member.userId,
          schoolId: p.schoolId,
          metadata: {
            uniqueId: member.uniqueId,
            purpose,
            attendanceMarkedClass,
          },
        },
        tx,
      );

      return {
        member,
        purpose,
        recorded: true as const,
        attendanceMarkedClass,
        attendanceNote,
      };
    });
  }

  /** Shared resolve: tenant-scoped lookup + optional audit (GET path only). */
  private async resolveInTx(
    tx: TenantTx,
    p: Principal,
    rawCode: string,
    auditLookup: boolean,
  ): Promise<MemberScanDto> {
    const code = rawCode.trim();
    {
      // RLS scopes this to the caller's school; a foreign uniqueId matches nothing.
      const user = await tx.user.findFirst({
        where: { uniqueId: code },
        select: {
          id: true,
          uniqueId: true,
          name: true,
          status: true,
          roles: { select: { role: { select: { name: true } } } },
          studentProfile: { select: { admissionNumber: true } },
        },
      });
      if (!user) {
        // 404, not 403: do not disclose that the code exists in another tenant.
        throw new NotFoundException("No member with that code in this school");
      }

      const roleNames = user.roles.map((r) => r.role.name);
      const role = roleNames.includes("student")
        ? "student"
        : (roleNames.find((r) => r !== "student") ?? roleNames[0] ?? "member");

      // Class name for a student (their current enrolment), best-effort.
      let className: string | null = null;
      const enrolment = await tx.enrollment.findFirst({
        where: { studentId: user.id, status: "ACTIVE" },
        select: { class: { select: { name: true } } },
      });
      className = enrolment?.class?.name ?? null;

      if (auditLookup) {
        await this.audit.record(
          {
            actorId: p.userId,
            action: "member.scan",
            entity: "user",
            entityId: user.id,
            schoolId: p.schoolId,
            metadata: { uniqueId: user.uniqueId },
          },
          tx, // REQUIRED — record() drops the entry without the active tx.
        );
      }

      return {
        userId: user.id,
        uniqueId: user.uniqueId,
        name: user.name,
        role,
        admissionNumber: user.studentProfile?.admissionNumber ?? null,
        className,
        status: user.status,
      };
    }
  }

  /**
   * WHEN DID THIS PERSON COME AND GO.
   *
   * `scan_event` was written on every scan and read by nothing — no endpoint,
   * no query, no export. A school could scan a child out at the gate and then
   * had no way to ask when they left, which is the only question a gate log
   * exists to answer. The table already carried the indexes such a reader
   * needs, `(schoolId, memberId)` and `(schoolId, createdAt)`, so it was
   * designed to be read and the readers were simply never written.
   *
   * // SECURITY: this is movement data about a minor, so the read is AUDITED
   * like every other read of a pupil's record (Golden Rule #5). RLS scopes it
   * to the caller's school; the `member.scan` permission — the one that already
   * governs the desk — decides who may ask.
   *
   * Bounded by DAYS and by rows: on the largest table the platform stores,
   * "everything for this pupil" is not a query anyone should be able to ask by
   * accident.
   */
  async history(
    p: Principal,
    memberId: string,
    days = 30,
  ): Promise<ScanEventDto[]> {
    const window = Math.min(Math.max(days, 1), 180);
    const since = new Date(Date.now() - window * 86_400_000);
    return this.db.runAsTenant(this.ctx(p), async (tx) => {
      const member = await tx.user.findFirst({
        where: { id: memberId },
        select: { id: true },
      });
      // 404-not-403: whether a member of another school exists is not something
      // this answers.
      if (!member) throw new NotFoundException("Member not found");
      const rows = (await tx.scanEvent.findMany({
        where: { memberId, createdAt: { gte: since } },
        orderBy: { createdAt: "desc" },
        take: SCAN_HISTORY_CAP,
      })) as Array<{
        id: string;
        memberId: string;
        scannedById: string;
        purpose: string;
        note: string | null;
        createdAt: Date;
      }>;
      await this.audit.record(
        {
          actorId: p.userId,
          action: "member.scan.history",
          entity: "scan_event",
          entityId: memberId,
          schoolId: p.schoolId,
          metadata: { days: window, rows: rows.length },
        },
        tx,
      );
      return this.decorate(tx, rows);
    });
  }

  /**
   * The day at the desk — every scan, newest first.
   *
   * The other question a gate log answers: who is on the premises, and what has
   * the desk been doing. Uses the `(schoolId, createdAt)` index.
   */
  async today(p: Principal): Promise<ScanEventDto[]> {
    return this.db.runAsTenant(this.ctx(p), async (tx) => {
      const { timezone } = await this.region.forSchool(p.schoolId);
      // The SCHOOL's day, not the server's UTC one — the same rule the register
      // and the term lock use.
      const start = schoolToday(timezone);
      const rows = (await tx.scanEvent.findMany({
        where: { createdAt: { gte: start } },
        orderBy: { createdAt: "desc" },
        take: SCAN_HISTORY_CAP,
      })) as Array<{
        id: string;
        memberId: string;
        scannedById: string;
        purpose: string;
        note: string | null;
        createdAt: Date;
      }>;
      await this.audit.record(
        {
          actorId: p.userId,
          action: "member.scan.today",
          entity: "scan_event",
          entityId: p.schoolId,
          schoolId: p.schoolId,
          metadata: { rows: rows.length },
        },
        tx,
      );
      return this.decorate(tx, rows);
    });
  }

  /** Names for the two people on each row, in ONE lookup rather than per row. */
  private async decorate(
    tx: TenantTx,
    rows: Array<{
      id: string;
      memberId: string;
      scannedById: string;
      purpose: string;
      note: string | null;
      createdAt: Date;
    }>,
  ): Promise<ScanEventDto[]> {
    if (rows.length === 0) return [];
    const ids = [...new Set(rows.flatMap((r) => [r.memberId, r.scannedById]))];
    const people = (await tx.user.findMany({
      where: { id: { in: ids } },
      select: { id: true, name: true },
    })) as Array<{ id: string; name: string }>;
    const nameOf = new Map(people.map((u) => [u.id, u.name]));
    return rows.map((r) => ({
      id: r.id,
      memberId: r.memberId,
      memberName: nameOf.get(r.memberId) ?? "Unknown",
      scannedById: r.scannedById,
      scannedByName: nameOf.get(r.scannedById) ?? "Unknown",
      purpose: (isScanPurpose(r.purpose)
        ? r.purpose
        : "CHECK_IN") as ScanPurpose,
      note: r.note,
      at: r.createdAt,
    }));
  }
}
