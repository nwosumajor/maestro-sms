// =============================================================================
// OperatorExportService — super_admin cross-tenant STUDENT DATA export (NDPR)
// =============================================================================
// The lawful-request path for a platform owner to hand a school the data of some
// of its students (e.g. records requested years later). Runs under the TARGET
// school's tenant context (the same per-school GUC pattern the operator console
// uses for reads), so RLS still scopes every query to that one school — the
// operator can't accidentally pull another tenant's rows. Each student's bundle
// is built by the SAME PrivacyService.collectStudentBundle the in-school NDPR
// export uses (one definition of "a student's data"). Every export is audited in
// the operator's own tenant.
//
// Safety: medical data is OPT-IN (`includeMedical`) and decrypted with the target
// school's key; students are collected one-per-transaction so a whole-school
// export can't blow the 5s interactive-transaction cap.
// =============================================================================

import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import {
  AUDIT_LOG_SERVICE,
  TENANT_DATABASE,
  type AuditLogService,
  type Principal,
  type TenantDatabase,
} from "../integrity/integrity.foundation";
import { PrivacyService } from "../privacy/privacy.service";

/** Hard cap on one export so a request can't build an unbounded response. */
const MAX_STUDENTS = 1000;

@Injectable()
export class OperatorExportService {
  constructor(
    @Inject(TENANT_DATABASE) private readonly db: TenantDatabase,
    @Inject(AUDIT_LOG_SERVICE) private readonly audit: AuditLogService,
    private readonly privacy: PrivacyService,
  ) {}

  async exportStudents(
    p: Principal,
    schoolId: string,
    opts: { studentIds?: string[]; includeMedical?: boolean },
  ) {
    const includeMedical = !!opts.includeMedical;

    // 1. Resolve the school name + the roster of student ids in one short tx.
    const { school, ids } = await this.db.runAsTenant({ schoolId, userId: p.userId }, async (tx) => {
      const school = await tx.school.findFirst({ where: { id: schoolId }, select: { id: true, name: true } });
      if (!school) throw new NotFoundException("School not found");
      let ids: string[];
      if (opts.studentIds && opts.studentIds.length > 0) {
        // Only ids that are genuinely students IN THIS SCHOOL survive (RLS + role).
        const found = await tx.user.findMany({
          where: { id: { in: opts.studentIds }, roles: { some: { role: { name: "student" } } } },
          select: { id: true },
        });
        ids = found.map((u: { id: string }) => u.id);
      } else {
        const all = await tx.user.findMany({
          where: { roles: { some: { role: { name: "student" } } } },
          select: { id: true },
          orderBy: { name: "asc" },
          take: MAX_STUDENTS,
        });
        ids = all.map((u: { id: string }) => u.id);
      }
      return { school, ids };
    });

    // 2. Collect each student's bundle in its OWN short tenant tx.
    const students: unknown[] = [];
    for (const id of ids) {
      const bundle = await this.db.runAsTenant({ schoolId, userId: p.userId }, (tx) =>
        this.privacy.collectStudentBundle(tx, id, { schoolId, includeMedical }),
      );
      students.push(bundle);
    }

    // 3. Audit the disclosure in the OPERATOR's own tenant (best-effort; the read
    //    already happened and is the source of truth).
    await this.db
      .runAsTenant({ schoolId: p.schoolId, userId: p.userId }, (tx) =>
        this.audit.record(
          {
            actorId: p.userId,
            action: "operator.students.export",
            entity: "school",
            entityId: schoolId,
            schoolId: p.schoolId,
            metadata: { targetSchoolId: schoolId, count: students.length, includeMedical },
          },
          tx,
        ),
      )
      .catch(() => undefined);

    return {
      exportedAt: new Date().toISOString(),
      exportedBy: p.userId,
      school,
      includeMedical,
      count: students.length,
      students,
    };
  }
}
