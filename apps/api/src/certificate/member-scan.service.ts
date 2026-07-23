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
import type { MemberScanDto, ScanPurpose, ScanRecordResultDto } from "@sms/types";
import { randomUUID } from "node:crypto";
import {
  AUDIT_LOG_SERVICE,
  TENANT_DATABASE,
  type AuditLogService,
  type Principal,
  type TenantContext,
  type TenantDatabase,
  type TenantTx,
} from "../integrity/integrity.foundation";

@Injectable()
export class MemberScanService {
  constructor(
    @Inject(TENANT_DATABASE) private readonly db: TenantDatabase,
    @Inject(AUDIT_LOG_SERVICE) private readonly audit: AuditLogService,
  ) {}

  private ctx(p: Principal): TenantContext {
    return { schoolId: p.schoolId, userId: p.userId };
  }

  /** Resolve a scanned code to a member of the caller's school, or 404. */
  async resolve(p: Principal, rawCode: string): Promise<MemberScanDto> {
    return this.db.runAsTenant(this.ctx(p), (tx) => this.resolveInTx(tx, p, rawCode, true));
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
          attendanceNote = "Not a student — movement recorded, no register marked.";
        } else {
          const enrolment = await tx.enrollment.findFirst({
            where: { studentId: member.userId, status: "ACTIVE" },
            select: { classId: true, class: { select: { name: true } } },
          });
          if (!enrolment) {
            attendanceNote = "No active class — attendance not marked.";
          } else {
            const today = new Date();
            today.setUTCHours(0, 0, 0, 0);
            const session = await tx.attendanceSession.upsert({
              where: { classId_date: { classId: enrolment.classId, date: today } },
              update: {},
              create: { schoolId: p.schoolId, classId: enrolment.classId, date: today, takenById: p.userId },
              select: { id: true },
            });
            await tx.$executeRaw`
              INSERT INTO "attendance_record" ("id","schoolId","sessionId","studentId","status","note","createdAt","updatedAt")
              VALUES (${randomUUID()}::uuid, ${p.schoolId}::uuid, ${session.id}::uuid, ${member.userId}::uuid, 'PRESENT'::"AttendanceStatus", 'scan check-in', now(), now())
              ON CONFLICT ("sessionId","studentId")
              DO UPDATE SET "status" = 'PRESENT', "updatedAt" = now()
            `;
            attendanceMarkedClass = enrolment.class?.name ?? null;
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
          metadata: { uniqueId: member.uniqueId, purpose, attendanceMarkedClass },
        },
        tx,
      );

      return { member, purpose, recorded: true as const, attendanceMarkedClass, attendanceNote };
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
}
