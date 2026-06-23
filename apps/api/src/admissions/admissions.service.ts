// =============================================================================
// AdmissionsService — public intake (quarantined) + staff review
// =============================================================================
// The PUBLIC submit resolves the school by SLUG (the School registry is
// RLS-exempt, so readable without tenant context), then inserts into the school's
// quarantined applications with the RLS GUC set to that resolved school — never
// to client-supplied data. Applications never touch the student/user tables.
// =============================================================================

import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import {
  AUDIT_LOG_SERVICE,
  TENANT_DATABASE,
  type AuditLogService,
  type Principal,
  type TenantContext,
  type TenantDatabase,
} from "../integrity/integrity.foundation";

const ZERO = "00000000-0000-0000-0000-000000000000";

export interface AdmissionInput {
  schoolSlug: string;
  applicantName: string;
  applicantEmail: string;
  applicantPhone?: string | null;
  childName: string;
  childDob?: string | null;
  notes?: string | null;
}

@Injectable()
export class AdmissionsService {
  constructor(
    @Inject(TENANT_DATABASE) private readonly db: TenantDatabase,
    @Inject(AUDIT_LOG_SERVICE) private readonly audit: AuditLogService,
  ) {}

  private ctx(p: Principal): TenantContext {
    return { schoolId: p.schoolId, userId: p.userId };
  }

  /** PUBLIC: submit an application to a school by slug. */
  async submit(input: AdmissionInput) {
    // School is RLS-exempt, so we can resolve the slug under a placeholder GUC.
    const school = await this.db.runAsTenant<{ id: string } | null>(
      { schoolId: ZERO, userId: ZERO },
      (tx) => tx.school.findFirst({ where: { slug: input.schoolSlug, status: "ACTIVE" }, select: { id: true } }),
    );
    if (!school) throw new NotFoundException("School not found");

    return this.db.runAsTenant({ schoolId: school.id, userId: ZERO }, (tx) =>
      tx.admissionApplication.create({
        data: {
          schoolId: school.id,
          applicantName: input.applicantName,
          applicantEmail: input.applicantEmail,
          applicantPhone: input.applicantPhone ?? null,
          childName: input.childName,
          childDob: input.childDob ? new Date(input.childDob) : null,
          notes: input.notes ?? null,
        },
        select: { id: true, status: true },
      }),
    );
  }

  async list(p: Principal) {
    return this.db.runAsTenant(this.ctx(p), (tx) =>
      tx.admissionApplication.findMany({ orderBy: { createdAt: "desc" }, take: 200 }),
    );
  }

  async updateStatus(p: Principal, id: string, status: "NEW" | "REVIEWING" | "ACCEPTED" | "REJECTED", note?: string) {
    return this.db.runAsTenant(this.ctx(p), async (tx) => {
      const app = await tx.admissionApplication.findFirst({ where: { id }, select: { id: true } });
      if (!app) throw new NotFoundException("Application not found");
      const updated = await tx.admissionApplication.update({
        where: { id },
        data: { status, reviewedById: p.userId, reviewNote: note ?? null },
      });
      await this.audit.record(
        { actorId: p.userId, action: `admission.${status.toLowerCase()}`, entity: "admission_application", entityId: id, schoolId: p.schoolId },
        tx,
      );
      return updated;
    });
  }
}
