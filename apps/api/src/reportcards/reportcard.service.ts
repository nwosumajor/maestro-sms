// =============================================================================
// ReportCardService — generate a PDF report card from grades + attendance
// =============================================================================
// Pulls a student's graded submissions and attendance summary (RLS-scoped),
// renders a PDF with pdfkit, and returns the bytes. Relationship-scoped: staff
// any student, teacher their students, parent their children, student self.
// Generating one is audit-logged and notifies the guardians.
// =============================================================================

import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import PDFDocument from "pdfkit";
import {
  AUDIT_LOG_SERVICE,
  TENANT_DATABASE,
  type AuditLogService,
  type Principal,
  type TenantContext,
  type TenantDatabase,
  type TenantTx,
} from "../integrity/integrity.foundation";
import { NotificationService } from "../notifications/notification.service";
import { BrandingService } from "../branding/branding.service";

const STAFF_WIDE = new Set(["school_admin", "principal", "super_admin"]);

@Injectable()
export class ReportCardService {
  constructor(
    @Inject(TENANT_DATABASE) private readonly db: TenantDatabase,
    @Inject(AUDIT_LOG_SERVICE) private readonly audit: AuditLogService,
    private readonly notifications: NotificationService,
    private readonly branding: BrandingService,
  ) {}

  private ctx(p: Principal): TenantContext {
    return { schoolId: p.schoolId, userId: p.userId };
  }

  async generate(p: Principal, studentId: string): Promise<{ buffer: Buffer; filename: string }> {
    const data = await this.db.runAsTenant(this.ctx(p), async (tx) => {
      await this.assertCanAccess(tx, p, studentId);
      const student = await tx.user.findFirst({ where: { id: studentId }, select: { name: true } });
      if (!student) throw new NotFoundException("Student not found");
      const school = await tx.school.findFirst({ where: { id: p.schoolId }, select: { name: true } });

      const subs = await tx.submission.findMany({
        where: { studentId },
        include: { assessment: { select: { title: true } }, grade: true },
      });
      const grades = (subs as Array<{ assessment: { title: string }; grade: { score: number; maxScore: number } | null }>)
        .filter((s) => s.grade)
        .map((s) => ({ title: s.assessment.title, score: s.grade!.score, maxScore: s.grade!.maxScore }));

      const recs = await tx.attendanceRecord.findMany({ where: { studentId }, select: { status: true } });
      const att = { PRESENT: 0, ABSENT: 0, LATE: 0, EXCUSED: 0 } as Record<string, number>;
      for (const r of recs as Array<{ status: string }>) att[r.status] = (att[r.status] ?? 0) + 1;

      await this.audit.record(
        { actorId: p.userId, action: "reportcard.generate", entity: "user", entityId: studentId, schoolId: p.schoolId },
        tx,
      );
      const guardians = await tx.parentChild.findMany({ where: { studentId }, select: { parentId: true } });
      return {
        studentName: student.name,
        schoolName: school?.name ?? "",
        grades,
        att,
        guardianIds: (guardians as Array<{ parentId: string }>).map((g) => g.parentId),
      };
    });

    const logo = await this.branding.getLogoBytes(p.schoolId).catch(() => null);
    const buffer = await this.renderPdf(data, logo);

    // Best-effort: tell the guardians a report card is ready.
    try {
      for (const id of data.guardianIds) {
        await this.notifications.enqueue(this.ctx(p), {
          recipientId: id,
          type: "DOCUMENT_AVAILABLE",
          title: "Report card ready",
          body: `A new report card for ${data.studentName} has been generated.`,
        });
      }
    } catch {
      /* non-fatal */
    }

    return { buffer, filename: `report-card-${data.studentName.replace(/\s+/g, "-").toLowerCase()}.pdf` };
  }

  private renderPdf(
    d: {
      studentName: string;
      schoolName: string;
      grades: { title: string; score: number; maxScore: number }[];
      att: Record<string, number>;
    },
    logo?: Buffer | null,
  ): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const doc = new PDFDocument({ margin: 50, size: "A4" });
      const chunks: Buffer[] = [];
      doc.on("data", (c: Buffer) => chunks.push(c));
      doc.on("end", () => resolve(Buffer.concat(chunks)));
      doc.on("error", reject);

      // School logo, centred above the heading (best-effort — never breaks the PDF).
      if (logo) {
        try {
          doc.image(logo, doc.page.width / 2 - 26, 45, { fit: [52, 52], align: "center" });
          doc.moveDown(3.5);
        } catch {
          /* ignore unsupported/corrupt image */
        }
      }
      doc.fontSize(22).text(d.schoolName || "Report Card", { align: "center" });
      doc.moveDown(0.3).fontSize(14).fillColor("#666").text("Student Report Card", { align: "center" });
      doc.fillColor("#000").moveDown(1);
      doc.fontSize(12).text(`Student: ${d.studentName}`);
      doc.text(`Generated: ${new Date().toLocaleString()}`);
      doc.moveDown(1);

      doc.fontSize(15).text("Grades");
      doc.moveDown(0.3).fontSize(11);
      if (d.grades.length === 0) {
        doc.fillColor("#888").text("No grades recorded.").fillColor("#000");
      } else {
        for (const g of d.grades) {
          const pct = g.maxScore ? Math.round((g.score / g.maxScore) * 100) : 0;
          doc.text(`• ${g.title}: ${g.score}/${g.maxScore}  (${pct}%)`);
        }
      }
      doc.moveDown(1);

      doc.fontSize(15).text("Attendance");
      doc.moveDown(0.3).fontSize(11);
      doc.text(`Present: ${d.att.PRESENT}    Late: ${d.att.LATE}    Absent: ${d.att.ABSENT}    Excused: ${d.att.EXCUSED}`);
      const total = d.att.PRESENT + d.att.LATE + d.att.ABSENT + d.att.EXCUSED;
      if (total) doc.text(`Attendance rate: ${Math.round(((d.att.PRESENT + d.att.LATE) / total) * 100)}%`);

      doc.end();
    });
  }

  private async assertCanAccess(tx: TenantTx, p: Principal, studentId: string) {
    if (p.roles.some((r) => STAFF_WIDE.has(r))) return;
    if (p.userId === studentId) return;
    const link = await tx.parentChild.findFirst({ where: { parentId: p.userId, studentId }, select: { id: true } });
    if (link) return;
    const taught = await tx.classTeacher.findMany({ where: { teacherId: p.userId }, select: { classId: true } });
    if (taught.length) {
      const enr = await tx.enrollment.findFirst({
        where: { studentId, classId: { in: taught.map((t: { classId: string }) => t.classId) } },
        select: { id: true },
      });
      if (enr) return;
    }
    throw new NotFoundException("Student not found");
  }
}
