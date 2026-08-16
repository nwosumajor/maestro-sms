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
import { assertDocumentsReleasable } from "../lms/leaver-documents";
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
import { TRAIT_GROUPS, TRAIT_SCALE, computeTermSubjectGrade, averageOf, sessionAverageScope } from "@sms/types";
import { SchoolRegionService } from "../foundation/school-region.service";
import type { TermSubjectRowDto } from "@sms/types";

const STAFF_WIDE = new Set(["school_admin", "principal"]);

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
    private readonly region: SchoolRegionService,
  ) {}

  private ctx(p: Principal): TenantContext {
    return { schoolId: p.schoolId, userId: p.userId };
  }

  async generate(p: Principal, studentId: string, termId?: string): Promise<{ buffer: Buffer; filename: string }> {
    // Resolve the term: the one asked for, else the current term. A report card
    // is a TERM document.
    // A LEAVER'S DOCUMENTS ARE THE PRINCIPAL'S TO RELEASE. No effect on a pupil
    // still at the school — report cards go out every term and this must not
    // touch that. See StudentExitService.assertDocumentsReleasable.
    await this.db.runAsTenant(this.ctx(p), (tx) => assertDocumentsReleasable(tx, studentId));
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
    // The LETTER comes from the term report, not from a second call here. It used
    // to be computed locally with no bands — so every subject grade on the card
    // used the school's own scale while the overall grade beneath them used the
    // platform default. On a school with its own bands the two disagreed, on the
    // one line a family reads most closely.
    let termGrade: string | null = null;
    let sessionAverage: number | null = null;
    // How many of the session's terms the cumulative average actually covers.
    // `getStudentSessionReport` averages only terms that HAVE marks, which is the
    // right arithmetic — but the label said "all terms so far", which is a lie for
    // any school that joined mid-session. A parent reading a Term 3 card sees one
    // number and assumes the whole year is in it.
    let sessionTermsCounted = 0;
    let sessionTermsTotal = 0;
    // THE ANNUAL VIEW the printed format carries alongside the term's marks: each
    // subject's total in every term of the session, and its average across them.
    // A third-term card that shows only third-term marks tells a parent nothing
    // about the year, which is the decision the year actually turns on.
    //
    // It costs NOTHING extra: `getStudentSessionReport` already returns every
    // term, and the code below was throwing all but one of them away.
    let annualTermNames: string[] = [];
    let annualBySubject = new Map<string, Array<number | null>>();
    if (term) {
      const report = await this.termResults.getStudentSessionReport(p, { studentId, sessionId: term.sessionId });
      const tr = report.terms.find((t) => t.termId === term.id);
      subjectRows = tr?.subjects ?? [];
      termAverage = tr?.average ?? null;
      termGrade = tr?.averageGrade ?? null;
      sessionAverage = report.sessionAverage;
      sessionTermsTotal = report.terms.length;
      sessionTermsCounted = report.terms.filter((t) => t.average !== null).length;

      annualTermNames = report.terms.map((t) => t.termName);
      for (const row of subjectRows) {
        annualBySubject.set(
          row.subjectId,
          report.terms.map((t) => t.subjects.find((s) => s.subjectId === row.subjectId)?.total ?? null),
        );
      }
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
        // Rank on the SCHOOL's weighting, the same one the printed average uses.
        // Ranking on platform defaults while printing a school-weighted average
        // put the two numbers on different scales: a pupil could show the higher
        // average and the lower position, on the same page.
        const grading = (await this.region.academicInTx(tx, p.schoolId)).grading;
        const classResults = await tx.subjectResult.findMany({
          where: { classId: enrolment.classId, termId: term.id, status: "PUBLISHED" },
          // subjectId rides along so the PER-SUBJECT class average, lowest and
          // highest cost nothing: the rows are already here for the overall
          // ranking, and a second pass over an array is free where a second
          // query over a term's marks is not.
          select: { studentId: true, subjectId: true, exam: true, midterm: true, assignment: true, classNote: true },
        });
        const byStudent = new Map<string, number[]>();
        // PER SUBJECT: what the class scored, so the row can carry the average,
        // the lowest and the highest beside the pupil's own mark. A parent
        // reading "65" learns something quite different when the class average is
        // 49 than when it is 82, and this is the same pass that ranks them.
        const bySubject = new Map<string, number[]>();
        for (const r of classResults) {
          const { total } = computeTermSubjectGrade(
            { exam: r.exam, midterm: r.midterm, assignment: r.assignment, classNote: r.classNote },
            grading?.components,
          );
          const arr = byStudent.get(r.studentId) ?? [];
          arr.push(total);
          byStudent.set(r.studentId, arr);
          const sub = bySubject.get(r.subjectId) ?? [];
          sub.push(total);
          bySubject.set(r.subjectId, sub);
        }
        for (const row of subjectRows) {
          const totals = bySubject.get(row.subjectId) ?? [];
          if (totals.length === 0) continue;
          row.classAverage = Math.round(totals.reduce((a, b) => a + b, 0) / totals.length);
          row.classLowest = Math.min(...totals);
          row.classHighest = Math.max(...totals);
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
      // THE TERM FRAME the printed format carries: when this term ran, when the
      // next one starts, and how many days the school actually opened. "Times
      // school opened" is the denominator a parent reads the attendance against
      // — without it "present: 46" says nothing.
      let termBegins: Date | null = null;
      let termEnds: Date | null = null;
      let nextTermBegins: Date | null = null;
      let daysOpened = 0;
      if (term) {
        const t = (await tx.term.findFirst({
          where: { id: term.id },
          select: { startDate: true, endDate: true, sessionId: true, sequence: true },
        })) as { startDate: Date | null; endDate: Date | null; sessionId: string; sequence: number } | null;
        termBegins = t?.startDate ?? null;
        termEnds = t?.endDate ?? null;
        if (t) {
          const next = (await tx.term.findFirst({
            where: { sessionId: t.sessionId, sequence: { gt: t.sequence } },
            orderBy: { sequence: "asc" },
            select: { startDate: true },
          })) as { startDate: Date | null } | null;
          nextTermBegins = next?.startDate ?? null;
        }
        // Days the register was actually taken for this pupil's class — the
        // school's own record of opening, not a count of weekdays.
        if (enrolment) {
          const sessions = await tx.attendanceSession.findMany({
            where: {
              classId: enrolment.classId,
              ...(termBegins && termEnds ? { date: { gte: termBegins, lte: termEnds } } : {}),
            },
            select: { id: true },
          });
          daysOpened = sessions.length;
        }
      }

      // Behavioural ratings, printed beside the marks and never averaged with
      // them. Read directly here rather than through the trait service: this is
      // already inside the pupil's own access check.
      const traitRatings = term
        ? ((await tx.studentTraitRating.findMany({
            where: { studentId, termId: term.id },
            select: { traitKey: true, score: true },
          })) as Array<{ traitKey: string; score: number }>)
        : [];

      // The footer totals. TOTAL is this term's marks added up — the figure the
      // printed format shows beside the position — and CUMULATIVE is the same
      // across every term recorded so far.
      const totalTermScore = subjectRows.reduce((n, r) => n + (r.total ?? 0), 0);

      // THE PROMOTION LINE — printed only when somebody has actually decided it.
      //
      // The end-of-year card a parent recognises says "PROMOTED TO SS2". The
      // platform must never derive that from the averages sitting a few lines
      // above it (Golden Rule #8): promotion is a human decision, taken on a
      // promotion batch, reviewed and APPROVED by a second person. So this reads
      // the recorded decision and prints nothing at all when there isn't one —
      // an absent line is honest, a computed one would be the system awarding a
      // year it has no standing to award.
      let promotionLine: string | null = null;
      if (term && enrolment) {
        const batches = (await tx.promotionBatch.findMany({
          where: { sourceClassId: enrolment.classId, termId: term.id, status: "APPROVED" },
          select: { studentIds: true, decisions: true, targetClassId: true, targetClass: { select: { name: true } } },
          orderBy: { createdAt: "desc" },
        })) as Array<{
          studentIds: unknown;
          decisions: unknown;
          targetClassId: string | null;
          targetClass: { name: string } | null;
        }>;
        for (const b of batches) {
          const ids = Array.isArray(b.studentIds) ? (b.studentIds as string[]) : [];
          if (!ids.includes(studentId)) continue;
          const decisions = Array.isArray(b.decisions)
            ? (b.decisions as Array<{ studentId: string; outcome: string; targetClassId?: string; note?: string }>)
            : [];
          const mine = decisions.find((d) => d.studentId === studentId);
          // A legacy batch carries no per-student decisions: every pupil listed
          // was promoted to the batch's target.
          const outcome = mine?.outcome ?? "PROMOTE";
          if (outcome === "RETAIN") promotionLine = "TO REPEAT THE CLASS";
          else if (outcome === "DEMOTE") promotionLine = "TRANSFERRED TO A LOWER CLASS";
          else if (b.targetClass?.name) promotionLine = `PROMOTED TO ${b.targetClass.name.toUpperCase()}`;
          else if (b.targetClassId === null) promotionLine = "GRADUATED";
          else promotionLine = "PROMOTED";
          break;
        }
      }

      return {
        promotionLine,
        annualTermNames,
        annualBySubject: Object.fromEntries(annualBySubject),
        studentName: student.name,
        schoolName: school?.name ?? "",
        termBegins,
        termEnds,
        nextTermBegins,
        daysOpened,
        traitRatings,
        totalTermScore,
        admissionNumber: profile?.admissionNumber ?? null,
        className: enrolment?.class?.name ?? null,
        termName: term?.name ?? null,
        subjects: subjectRows,
        termAverage,
        termGrade,
        position,
        classSize,
        sessionAverage,
        sessionTermsCounted,
        sessionTermsTotal,
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
      sessionTermsCounted: number;
      sessionTermsTotal: number;
      att: Record<string, number>;
      remarks: { classTeacher: string | null; head: string | null };
      /** The term frame the printed format carries. */
      termBegins: Date | null;
      termEnds: Date | null;
      nextTermBegins: Date | null;
      /** Days the register was actually taken — the denominator for attendance. */
      daysOpened: number;
      /** Behavioural ratings, printed beside the marks and never mixed in. */
      traitRatings: Array<{ traitKey: string; score: number }>;
      totalTermScore: number;
      /** Every term of the session, in order — the annual columns' headings. */
      annualTermNames: string[];
      /** subjectId → that subject's total in each of those terms (null = no marks). */
      annualBySubject: Record<string, Array<number | null>>;
      /** The recorded promotion decision, or null when nobody has taken one. */
      promotionLine: string | null;
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
      // Eight columns now (Pos added). Re-spaced rather than squeezed on the
      // end: the last column runs to 545, so appending without re-spacing would
      // have pushed Grade off the page edge.
      const colX = [startX, 195, 250, 305, 358, 411, 464, 508];
      const drawRow = (cells: string[], bold = false) => {
        const y = doc.y;
        doc.fontSize(10).font(bold ? "Helvetica-Bold" : "Helvetica");
        cells.forEach((c, i) => doc.text(c, colX[i], y, { width: (colX[i + 1] ?? 545) - colX[i] - 4, lineBreak: false }));
        doc.moveDown(0.6);
      };
      doc.fontSize(14).font("Helvetica-Bold").text("Grades", startX);
      doc.moveDown(0.2).font("Helvetica");
      // POS is this pupil's rank in THAT subject among classmates — a number
      // about them, never another child's marks or name. Same posture as the
      // overall class position below.
      // C.A. is the school's three continuous-assessment components added up —
      // the printed format shows "C.A. /40 + Exam /60", which is the same marks
      // this platform already holds as four. Derived, never stored twice.
      drawRow(["Subject", "C.A.", "Exam", "Total", "Grade", "Pos", "Class avg", "Low/High"], true);
      doc.moveTo(startX, doc.y).lineTo(545, doc.y).strokeColor("#ccc").stroke();
      doc.moveDown(0.3);
      if (d.subjects.length === 0) {
        doc.fontSize(10).fillColor("#888").text("No published grades for this term yet.", startX).fillColor("#000");
      } else {
        for (const sub of d.subjects) {
          // "3/28" reads better than a bare 3: a position is meaningless without
          // knowing how many were ranked, and ungraded pupils are excluded from
          // that count rather than counted as beaten.
          const pos = sub.subjectPosition && sub.subjectRanked ? `${sub.subjectPosition}/${sub.subjectRanked}` : "—";
          // An asterisk, not a footnote nobody reads in isolation: a total with a
          // component still unmarked counts that component as ZERO, so 24 here can
          // mean "scored 24" or "only the class note is in". A family cannot tell
          // those apart, and the second one is not a fail.
          const ca = [sub.midterm, sub.assignment, sub.classNote].some((v) => v !== null)
            ? (sub.midterm ?? 0) + (sub.assignment ?? 0) + (sub.classNote ?? 0)
            : null;
          const lowHigh =
            sub.classLowest != null && sub.classHighest != null ? `${sub.classLowest}/${sub.classHighest}` : "—";
          drawRow([
            sub.subjectName + (sub.complete ? "" : " *"),
            fmt(ca),
            fmt(sub.exam),
            fmt(sub.total),
            sub.grade ?? "—",
            pos,
            fmt(sub.classAverage ?? null),
            lowHigh,
          ]);
        }
      }
      // Said once, plainly, and only when it applies — a standing disclaimer on
      // every report card is one nobody reads.
      if (d.subjects.some((sx) => !sx.complete)) {
        doc.moveDown(0.2);
        doc.fontSize(8).font("Helvetica-Oblique").fillColor("#a15c00")
          .text(
            "* Not every component has been marked for this subject yet. Unmarked components count as zero, so this total is provisional.",
            startX,
          );
        doc.fillColor("#000");
      }
      doc.moveDown(0.4);
      doc.fontSize(11).font("Helvetica-Bold")
        .text(`Term average: ${fmt(d.termAverage)}${d.termGrade ? `  (${d.termGrade})` : ""}`, startX);
      if (d.position && d.classSize) {
        doc.font("Helvetica").text(`Position in class: ${d.position} of ${d.classSize}`, startX);
      }
      if (d.sessionAverage !== null) {
        // Name the terms it covers rather than claiming "all terms so far". A
        // school that onboarded in Term 2 has no Term 1 marks, and a cumulative
        // average over 2 of 3 terms must not be read as a full-year figure.
        const scope = sessionAverageScope(d.sessionTermsCounted, d.sessionTermsTotal);
        doc.font("Helvetica").fillColor("#666").text(`Cumulative session average (${scope}): ${d.sessionAverage}`, startX).fillColor("#000");
      }

      // Attendance (term-scoped).
      doc.moveDown(0.8).fontSize(14).font("Helvetica-Bold").text("Attendance", startX);
      doc.moveDown(0.2).font("Helvetica").fontSize(11);
      // The denominator first: "present 46" means nothing without the number of
      // days the school actually opened.
      if (d.daysOpened > 0) doc.text(`Times school opened: ${d.daysOpened}`, startX);
      // When the term ran, and when the next one starts — the line a parent
      // actually acts on, and the only date on the page that is about the future.
      const day = (v: Date | null) => (v ? new Date(v).toISOString().slice(0, 10) : null);
      const frame = [
        day(d.termBegins) ? `Term begins: ${day(d.termBegins)}` : null,
        day(d.termEnds) ? `Term ends: ${day(d.termEnds)}` : null,
        day(d.nextTermBegins) ? `Next term begins: ${day(d.nextTermBegins)}` : null,
      ].filter(Boolean);
      if (frame.length > 0) doc.text(frame.join("    "), startX);
      doc.text(`Present: ${d.att.PRESENT}    Late: ${d.att.LATE}    Absent: ${d.att.ABSENT}    Excused: ${d.att.EXCUSED}`, startX);
      const total = d.att.PRESENT + d.att.LATE + d.att.ABSENT + d.att.EXCUSED;
      if (total) doc.text(`Attendance rate: ${Math.round(((d.att.PRESENT + d.att.LATE) / total) * 100)}%`, startX);

      // SKILLS AND BEHAVIOUR — printed beside the marks, never mixed into them.
      // Grouped as the catalogue groups them, with the scale spelled out
      // underneath: "4" tells a parent nothing on its own, and a number a family
      // cannot interpret is how a behavioural rating becomes an argument.
      if (d.traitRatings.length > 0) {
        const scoreOf = new Map(d.traitRatings.map((r) => [r.traitKey, r.score]));
        doc.moveDown(0.8).fontSize(14).font("Helvetica-Bold").text("Skills and behaviour", startX);
        doc.moveDown(0.2).fontSize(9).font("Helvetica");
        for (const group of TRAIT_GROUPS) {
          const rated = group.traits.filter((t) => scoreOf.has(t.key));
          if (rated.length === 0) continue;
          doc.font("Helvetica-Bold").text(group.label, startX);
          doc.font("Helvetica").text(
            rated.map((t) => `${t.label}: ${scoreOf.get(t.key)}`).join("    "),
            startX,
            undefined,
            { width: 545 - startX },
          );
          doc.moveDown(0.2);
        }
        doc.fillColor("#666").fontSize(8).text(
          TRAIT_SCALE.map((r) => `${r.score} = ${r.label}`).join("   |   "),
          startX,
          undefined,
          { width: 545 - startX },
        );
        doc.fillColor("#000").fontSize(10);
      }

      // The footer figures the printed format carries beside the position.
      if (d.totalTermScore > 0) {
        doc.moveDown(0.6).fontSize(10).font("Helvetica-Bold").text(`Total term score: ${d.totalTermScore}`, startX);
        doc.font("Helvetica");
      }

      // THE YEAR, subject by subject — each term's total and the average across
      // them. Printed only once there is more than one term's marks to compare:
      // on a first-term card it would be the same column twice.
      const annualTerms = d.annualTermNames;
      const annualRows = d.subjects
        .map((s) => ({ name: s.subjectName, totals: d.annualBySubject[s.subjectId] ?? [] }))
        .filter((r) => r.totals.filter((t) => t !== null).length > 1);
      if (annualTerms.length > 1 && annualRows.length > 0) {
        doc.moveDown(0.8).fontSize(14).font("Helvetica-Bold").text("The year so far", startX);
        doc.moveDown(0.2).fontSize(9);
        const aw = [150, ...annualTerms.map(() => 62), 62];
        const ax = aw.map((_, i) => startX + aw.slice(0, i).reduce((a, b) => a + b, 0));
        const arow = (cells: string[], bold: boolean) => {
          doc.font(bold ? "Helvetica-Bold" : "Helvetica");
          const y = doc.y;
          cells.forEach((c, i) => doc.text(c, ax[i], y, { width: aw[i] - 4 }));
          doc.y = y + 13;
        };
        arow(["Subject", ...annualTerms, "Average"], true);
        for (const r of annualRows) {
          const present = r.totals.filter((t): t is number => t !== null);
          // The average counts the terms that HAVE marks — a missing term is an
          // absent measurement, and treating it as a zero would print a failure
          // the pupil never earned.
          const avg = present.length > 0 ? Math.round(present.reduce((a, b) => a + b, 0) / present.length) : null;
          arow([r.name, ...r.totals.map((t) => (t === null ? "—" : String(t))), fmt(avg)], false);
        }
      }

      // The promotion decision — printed only when a person has taken one.
      if (d.promotionLine) {
        doc.moveDown(0.6).fontSize(12).font("Helvetica-Bold").text(d.promotionLine, startX);
        doc.font("Helvetica").fontSize(10);
      }

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
