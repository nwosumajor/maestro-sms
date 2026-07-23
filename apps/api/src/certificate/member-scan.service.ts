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
import type { MemberScanDto } from "@sms/types";
import {
  AUDIT_LOG_SERVICE,
  TENANT_DATABASE,
  type AuditLogService,
  type Principal,
  type TenantContext,
  type TenantDatabase,
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
    const code = rawCode.trim();
    return this.db.runAsTenant(this.ctx(p), async (tx) => {
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

      return {
        userId: user.id,
        uniqueId: user.uniqueId,
        name: user.name,
        role,
        admissionNumber: user.studentProfile?.admissionNumber ?? null,
        className,
        status: user.status,
      };
    });
  }
}
