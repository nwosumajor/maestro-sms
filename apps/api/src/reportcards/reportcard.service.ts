// =============================================================================
// ReportCardService — generate a PDF report card from grades + attendance
// =============================================================================
// Pulls a student's graded submissions and attendance summary (RLS-scoped),
// renders a PDF with pdfkit, and returns the bytes to WHOEVER called generate
// (e.g. the principal, downloading their own copy). It is ALSO persisted into
// the Document Vault (type REPORT_CARD, already a DocumentsService "notifying"
// type) so the student/parent get a REAL, independently retrievable copy on
// their own /documents page — not just a notification promising one exists.
// Before this, only the caller's browser ever held the bytes: if staff
// generated it, the family's "report card ready" alert pointed at nothing they
// could actually open. Generating one is audit-logged; DocumentsService's own
// upload path notifies the guardians once the vault copy is confirmed live.
// =============================================================================

import { Inject, Injectable, Logger, NotFoundException } from "@nestjs/common";
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
import { BrandingService } from "../branding/branding.service";
import { DocumentsService } from "../documents/documents.service";
import { ReportCardRemarkService } from "./report-card-remark.service";
import { TermResultService } from "../gradebook/term-result.service";
import { computeTermSubjectGrade, gradeLetter, averageOf } from "@sms/types";
import type { TermSubjectRowDto } from "@sms/types";

const STAFF_WIDE = new Set(["school_admin", "principal", "super_admin"]);

@Injectable()
export class ReportCardService {
  private readonly logger = new Logger("ReportCard");

  constructor(
    @Inject(TENANT_DATABASE) private readonly db: TenantDatabase,
    @Inject(AUDIT_LOG_SERVICE) private readonly audit: AuditLogService,
    private readonly branding: BrandingService,
    private readonly documents: DocumentsService,
    private readonly remarks: ReportCardRemarkService,
    private readonly termResults: TermResultService,
  ) {}

  private ctx(p: Principal): TenantContext {
    return { schoolId: p.schoolId, userId: p.userId };
  }

  async generate(p: Principal, studentId: string, termId?: string): Promise<{ buffer: Buffer; filename: string }> {
    // Resolve the term: the one asked for, else the current term. A report card
    // is a TERM document.
    const term = await this.db.runAsTenant(this.ctx(p), async (tx) => {
      const t = termId
        ? await tx.term.findFirst({ where: { id: termId }, select: { id: true, name: true, sessionId: true, startDate: true, endDate: true } })
        : await tx.term.findFirst({ where: { isCurrent: true }, select: { id: true, name: true, sessionId: true, startDate: true, endDate: true } });
      return t;
    });

    // TERM-WEIGHTED subject grades — from the ONE grade source (TermResultService),
    // the same computation the scoresheet/broadsheet use, so they can never
    // diverge. Its own access check applies (student→self, parent→children
    // PUBLISHED-only, staff-of-class all).
    let subjectRows: TermSubjectRowDto[] = [];
    let termAverage: number | null = null;
    let sessionAverage: number | null = null;
    if (term) {
      const report = await this.termResults.getStudentSessionReport(p, { studentId, sessionId: term.sessionId });
      const tr = report.terms.find((t) => t.termId === term.id);
      subjectRows = tr?.subjects ?? [];
      termAverage = tr?.average ?? null;
      sessionAverage = report.sessionAverage;
    }

    const data = await this.db.runAsTenant(this.ctx(p), async (tx) => {
      await this.assertCanAccess(tx, p, studentId);
      const student = await tx.user.findFirst({ where: { id: studentId }, select: { name: true } });
      if (!student) throw new NotFoundException("Student not found");
      const school = await tx.school.findFirst({ where: { id: p.schoolId }, select: { name: true } });
      const profile = await tx.studentProfile.findFirst({ where: { studentId }, select: { admissionNumber: true } });
      const enrolment = await tx.enrollment.findFirst({
        where: { studentId, status: "ACTIVE" },
        select: { classId: true, class: { select: { name: true } } },
      });
      const remarks = term ? await this.remarks.remarksForPdf(tx, studentId, term.id) : { classTeacher: null, head: null };

      // OVERALL CLASS POSITION for the term: rank this student's term average
      // among classmates. Reads only aggregate positions (no other pupil's marks
      // are shown), from PUBLISHED results, via the same pure functions.
      let position: number | null = null;
      let classSize: number | null = null;
      if (term && enrolment) {
        const classResults = await tx.subjectResult.findMany({
          where: { classId: enrolment.classId, termId: term.id, status: "PUBLISHED" },
          select: { studentId: true, exam: true, midterm: true, assignment: true, classNote: true },
        });
        const byStudent = new Map<string, number[]>();
        for (const r of classResults) {
          const { total } = computeTermSubjectGrade({ exam: r.exam, midterm: r.midterm, assignment: r.assignment, classNote: r.classNote });
          const arr = byStudent.get(r.studentId) ?? [];
          arr.push(total);
          byStudent.set(r.studentId, arr);
        }
        const averages = [...byStudent.entries()]
          .map(([sid, totals]) => ({ sid, avg: averageOf(totals) }))
          .filter((x): x is { sid: string; avg: number } => x.avg !== null)
          .sort((a, b) => b.avg - a.avg);
        classSize = averages.length || null;
        const mine = averages.find((x) => x.sid === studentId);
        if (mine) {
          // Standard competition ranking (ties share a position).
          let pos = 0, seen = 0, prev: number | null = null;
          for (const x of averages) {
            seen += 1;
            if (prev === null || x.avg !== prev) { pos = seen; prev = x.avg; }
            if (x.sid === studentId) { position = pos; break; }
          }
        }
      }

      // Attendance summary — SCOPED to the term's date window (via session.date).
      const recs = await tx.attendanceRecord.findMany({
        where: {
          studentId,
          ...(term?.startDate && term?.endDate
            ? { session: { date: { gte: term.startDate, lte: term.endDate } } }
            : {}),
        },
        select: { status: true },
      });
      const att = { PRESENT: 0, ABSENT: 0, LATE: 0, EXCUSED: 0 } as Record<string, number>;
      for (const r of recs as Array<{ status: string }>) att[r.status] = (att[r.status] ?? 0) + 1;

      await this.audit.record(
        { actorId: p.userId, action: "reportcard.generate", entity: "user", entityId: studentId, schoolId: p.schoolId, metadata: { termId: term?.id ?? null } },
        tx,
      );
      return {
        studentName: student.name,
        schoolName: school?.name ?? "",
        admissionNumber: profile?.admissionNumber ?? null,
        className: enrolment?.class?.name ?? null,
        termName: term?.name ?? null,
        subjects: subjectRows,
        termAverage,
        termGrade: termAverage !== null ? gradeLetter(termAverage) : null,
        position,
        classSize,
        sessionAverage,
        att,
        remarks,
      };
    });

    const logo = await this.branding.getLogoBytes(p.schoolId).catch(() => null);
    const buffer = await this.renderPdf(data, logo);
    const filename = `report-card-${data.studentName.replace(/\s+/g, "-").toLowerCase()}.pdf`;

    // Persist into the Document Vault so the student/parent have their OWN
    // retrievable copy regardless of who generated it — best-effort: a vault
    // write failure must never block the caller from getting their PDF now.
    try {
      const { document } = await this.documents.createDocument(p, {
        studentId,
        type: "REPORT_CARD",
        title: filename,
        contentType: "application/pdf",
        sizeBytes: buffer.length,
      });
      // uploadBytes notifies the guardians once the vault copy is UPLOADED —
      // the ONE notify path, so the alert is never sent before there is
      // something real behind it.
      await this.documents.uploadBytes(p, document.id, buffer, "application/pdf");
    } catch (err) {
      this.logger.warn(`report card vault persist failed for student ${studentId} (non-fatal): ${String(err)}`);
    }

    return { buffer, filename };
  }

  private renderPdf(
    d: {
      studentName: string;
      schoolName: string;
      admissionNumber: string | null;
      className: string | null;
      termName: string | null;
      subjects: TermSubjectRowDto[];
      termAverage: number | null;
      termGrade: string | null;
      position: number | null;
      classSize: number | null;
      sessionAverage: number | null;
      att: Record<string, number>;
      remarks: { classTeacher: string | null; head: string | null };
    },
    logo?: Buffer | null,
  ): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const doc = new PDFDocument({ margin: 50, size: "A4" });
      const chunks: Buffer[] = [];
      doc.on("data", (c: Buffer) => chunks.push(c));
      doc.on("end", () => resolve(Buffer.concat(chunks)));
      doc.on("error", reject);
      const startX = 50;
      const fmt = (n: number | null): string => (n === null || n === undefined ? "—" : String(n));

      if (logo) {
        try {
          doc.image(logo, doc.page.width / 2 - 26, 45, { fit: [52, 52], align: "center" });
          doc.moveDown(3.5);
        } catch {
          /* ignore unsupported/corrupt image */
        }
      }
      doc.fontSize(22).text(d.schoolName || "Report Card", { align: "center" });
      doc.moveDown(0.3).fontSize(14).fillColor("#666")
        .text(d.termName ? `Report Card — ${d.termName}` : "Student Report Card", { align: "center" });
      doc.fillColor("#000").moveDown(0.8);

      doc.fontSize(11).text(`Student: ${d.studentName}`, startX);
      if (d.admissionNumber) doc.text(`Admission no.: ${d.admissionNumber}`, startX);
      if (d.className) doc.text(`Class: ${d.className}`, startX);
      doc.text(`Generated: ${new Date().toLocaleString()}`, startX);
      doc.moveDown(0.8);

      // Term-weighted subject table.
      const colX = [startX, 210, 265, 330, 395, 450, 510];
      const drawRow = (cells: string[], bold = false) => {
        const y = doc.y;
        doc.fontSize(10).font(bold ? "Helvetica-Bold" : "Helvetica");
        cells.forEach((c, i) => doc.text(c, colX[i], y, { width: (colX[i + 1] ?? 545) - colX[i] - 4, lineBreak: false }));
        doc.moveDown(0.6);
      };
      doc.fontSize(14).font("Helvetica-Bold").text("Grades", startX);
      doc.moveDown(0.2).font("Helvetica");
      drawRow(["Subject", "Exam/60", "Mid/20", "Assn/10", "Note/10", "Total", "Grade"], true);
      doc.moveTo(startX, doc.y).lineTo(545, doc.y).strokeColor("#ccc").stroke();
      doc.moveDown(0.3);
      if (d.subjects.length === 0) {
        doc.fontSize(10).fillColor("#888").text("No published grades for this term yet.", startX).fillColor("#000");
      } else {
        for (const sub of d.subjects) {
          drawRow([sub.subjectName, fmt(sub.exam), fmt(sub.midterm), fmt(sub.assignment), fmt(sub.classNote), fmt(sub.total), sub.grade ?? "—"]);
        }
      }
      doc.moveDown(0.4);
      doc.fontSize(11).font("Helvetica-Bold")
        .text(`Term average: ${fmt(d.termAverage)}${d.termGrade ? `  (${d.termGrade})` : ""}`, startX);
      if (d.position && d.classSize) {
        doc.font("Helvetica").text(`Position in class: ${d.position} of ${d.classSize}`, startX);
      }
      if (d.sessionAverage !== null) {
        doc.font("Helvetica").fillColor("#666").text(`Cumulative session average (all terms so far): ${d.sessionAverage}`, startX).fillColor("#000");
      }

      // Attendance (term-scoped).
      doc.moveDown(0.8).fontSize(14).font("Helvetica-Bold").text("Attendance", startX);
      doc.moveDown(0.2).font("Helvetica").fontSize(11);
      doc.text(`Present: ${d.att.PRESENT}    Late: ${d.att.LATE}    Absent: ${d.att.ABSENT}    Excused: ${d.att.EXCUSED}`, startX);
      const total = d.att.PRESENT + d.att.LATE + d.att.ABSENT + d.att.EXCUSED;
      if (total) doc.text(`Attendance rate: ${Math.round(((d.att.PRESENT + d.att.LATE) / total) * 100)}%`, startX);

      if (d.remarks.classTeacher || d.remarks.head) {
        doc.moveDown(0.8).fontSize(14).font("Helvetica-Bold").text("Remarks", startX);
        doc.moveDown(0.2).font("Helvetica").fontSize(11);
        if (d.remarks.classTeacher) {
          doc.font("Helvetica-Bold").text("Class teacher: ", startX, doc.y, { continued: true }).font("Helvetica").text(d.remarks.classTeacher);
        }
        if (d.remarks.head) {
          doc.moveDown(0.2).font("Helvetica-Bold").text("Head: ", startX, doc.y, { continued: true }).font("Helvetica").text(d.remarks.head);
        }
      }

      doc.font("Helvetica").fontSize(8).fillColor("#999").moveDown(1)
        .text("Term weighting: Exam 60 · Midterm 20 · Assignment 10 · Class note 10 = 100.", startX);
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
