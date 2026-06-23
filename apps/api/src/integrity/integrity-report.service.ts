// =============================================================================
// IntegrityReportService — read-side aggregation for the teacher dashboard
// =============================================================================
// Reads are AUDIT-LOGGED (Golden Rule #5: all integrity reads on minors' data are
// logged) and RELATIONSHIP-SCOPED (a teacher sees only their own assessments;
// school_admin sees all in-tenant). Everything is RLS-scoped underneath, so this
// can never reach another tenant. Returns evidence + a mandatory disclaimer,
// never a verdict (Golden Rule #8).
// =============================================================================

import { ForbiddenException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import {
  IntegritySignalSeverity,
  type IntegritySignalType,
} from "@sms/types";
import {
  INTEGRITY_REPORT_DISCLAIMER,
  type IntegrityReportDto,
  type IntegrityReportSignal,
} from "@sms/types";
import { INTEGRITY_PERMISSIONS } from "@sms/types";
import {
  AUDIT_LOG_SERVICE,
  TENANT_DATABASE,
  type AuditLogService,
  type Principal,
  type TenantDatabase,
  type TenantTx,
} from "./integrity.foundation";

const SEVERITY_ORDER: IntegritySignalSeverity[] = [
  IntegritySignalSeverity.INFO,
  IntegritySignalSeverity.LOW,
  IntegritySignalSeverity.MEDIUM,
  IntegritySignalSeverity.HIGH,
];

const SCHOOL_WIDE_ROLES = new Set(["school_admin", "super_admin"]);

@Injectable()
export class IntegrityReportService {
  constructor(
    @Inject(TENANT_DATABASE) private readonly db: TenantDatabase,
    @Inject(AUDIT_LOG_SERVICE) private readonly audit: AuditLogService,
  ) {}

  async getSubmissionReport(
    principal: Principal,
    submissionId: string,
  ): Promise<IntegrityReportDto> {
    // Defense in depth: the controller already requires integrity.report.read,
    // but we re-assert it here so the service is safe to call from anywhere.
    if (!principal.permissions.includes(INTEGRITY_PERMISSIONS.REPORT_READ)) {
      // Caller is authenticated but lacks the permission outright -> 403.
      throw new ForbiddenException();
    }

    return this.db.runAsTenant(
      { schoolId: principal.schoolId, userId: principal.userId },
      async (tx: TenantTx) => {
        const submission = await tx.submission.findFirst({
          where: { id: submissionId },
        });
        if (!submission) throw new NotFoundException("Submission not found");

        const assessment = await tx.assessment.findFirst({
          where: { id: submission.assessmentId },
        });
        if (!assessment) throw new NotFoundException("Submission not found");

        // Relationship scoping: a teacher may only see reports for assessments
        // they own. school_admin/super_admin see any in their tenant.
        const schoolWide = principal.roles.some((r) => SCHOOL_WIDE_ROLES.has(r));
        if (!schoolWide && assessment.createdById !== principal.userId) {
          // SECURITY: 404 not 403 — don't reveal that another teacher's
          // submission exists.
          throw new NotFoundException("Submission not found");
        }

        const signals = await tx.integritySignal.findMany({
          where: { submissionId: submission.id },
          orderBy: { createdAt: "desc" },
        });

        // GR#5: log the READ of a minor's integrity data.
        await this.audit.record(
          {
            actorId: principal.userId,
            action: "integrity.report.read",
            entity: "submission",
            entityId: submission.id,
            schoolId: principal.schoolId,
            metadata: { signalCount: signals.length },
          },
          tx,
        );

        return this.buildDto(submission, assessment, signals);
      },
    );
  }

  private buildDto(
    submission: {
      id: string;
      assessmentId: string;
      studentId: string;
      status: string;
      submittedAt: Date | null;
    },
    assessment: { title: string },
    rows: Array<{
      id: string;
      type: IntegritySignalType;
      source: IntegrityReportSignal["source"];
      severity: IntegritySignalSeverity;
      confidence: number;
      detector: string | null;
      evidence: Record<string, unknown>;
      createdAt: Date;
    }>,
  ): IntegrityReportDto {
    const bySeverity = {
      [IntegritySignalSeverity.INFO]: 0,
      [IntegritySignalSeverity.LOW]: 0,
      [IntegritySignalSeverity.MEDIUM]: 0,
      [IntegritySignalSeverity.HIGH]: 0,
    };
    const byType: Partial<Record<IntegritySignalType, number>> = {};
    let highestIdx = -1;

    const signals: IntegrityReportSignal[] = rows.map((r) => {
      bySeverity[r.severity] += 1;
      byType[r.type] = (byType[r.type] ?? 0) + 1;
      highestIdx = Math.max(highestIdx, SEVERITY_ORDER.indexOf(r.severity));
      return {
        id: r.id,
        type: r.type,
        source: r.source,
        severity: r.severity,
        confidence: r.confidence,
        detector: r.detector,
        evidence: r.evidence,
        createdAt: r.createdAt.toISOString(),
      };
    });

    return {
      submissionId: submission.id,
      assessmentId: submission.assessmentId,
      assessmentTitle: assessment.title,
      studentId: submission.studentId,
      status: submission.status,
      submittedAt: submission.submittedAt ? submission.submittedAt.toISOString() : null,
      generatedAt: new Date().toISOString(),
      summary: {
        total: rows.length,
        bySeverity,
        byType,
        highestSeverity: highestIdx >= 0 ? SEVERITY_ORDER[highestIdx] : null,
      },
      signals,
      disclaimer: INTEGRITY_REPORT_DISCLAIMER,
    };
  }
}
