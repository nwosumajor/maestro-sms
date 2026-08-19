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
import { TRAIT_GROUPS, TRAIT_SCALE, reportedTermGrade, averageOf, sessionAverageScope, resolveGradeBands, gradeLetter, gradeDescriptor } from "@sms/types";
import { GRADE_COMPONENTS, gradeComponentMax } from "@sms/types";
import type { GradeBand } from "@sms/types";
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
    let annualTermIds: string[] = [];
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
      annualTermIds = report.terms.map((t) => t.termId);
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
      const profile = await tx.studentProfile.findFirst({
        where: { studentId },
        select: { admissionNumber: true, gender: true },
      });
      // The guardians the printed format names at the foot of the card. Names
      // only — the card already goes to these families, and their contact
      // details belong on the SIS record, not on a document pupils carry home
      // in a bag.
      const guardianLinks = (await tx.parentChild.findMany({
        where: { studentId },
        select: { parentId: true },
      })) as Array<{ parentId: string }>;
      const guardianNames = guardianLinks.length
        ? ((await tx.user.findMany({
            where: { id: { in: guardianLinks.map((g) => g.parentId) } },
            select: { name: true },
            orderBy: { name: "asc" },
          })) as Array<{ name: string }>).map((u) => u.name)
        : [];
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
      const annualPosition = new Map<string, { position: number; of: number }>();
      // Resolved ONCE for the whole card. Rank on the SCHOOL's weighting, the
      // same one the printed average uses — ranking on platform defaults while
      // printing a school-weighted average put the two numbers on different
      // scales, so a pupil could show the higher average and the lower position
      // on the same page. The BANDS come from here too, so the grade key printed
      // at the foot of the card is the scale the letters above it were actually
      // computed on.
      const grading = (await this.region.academicInTx(tx, p.schoolId)).grading;
      const bands = resolveGradeBands(grading);

      // THE COHORT IS THE CLASS THE TERM'S MARKS WERE EARNED IN, which is not
      // the pupil's class today once they move mid-session — an ordinary thing
      // for a school to do. Every result row records its own classId; ranking on
      // current enrolment instead put an SS3 pupil's Term 1 mark against JSS1
      // A's roster, and set the class average, lowest and highest printed beside
      // their own mark to a different year group's figures.
      //
      // Falls back to the current enrolment when the pupil has no marks for the
      // term, where there is nothing to rank and nothing to get wrong.
      const ownTermRows = term
        ? ((await tx.subjectResult.findMany({
            where: { studentId, termId: term.id },
            select: { classId: true },
            take: 1,
          })) as Array<{ classId: string }>)
        : [];
      const cohortClassId = ownTermRows[0]?.classId ?? enrolment?.classId ?? null;
      // The card must also NAME that class. Printing the pupil's class today
      // above a term's marks earned elsewhere states the wrong fact in the
      // header — "JSS1 A" over a set of SS3 results.
      const cohortClassName =
        cohortClassId && cohortClassId !== enrolment?.classId
          ? ((await tx.class.findFirst({ where: { id: cohortClassId }, select: { name: true } })) as { name: string } | null)?.name ?? null
          : enrolment?.class?.name ?? null;

      if (term && cohortClassId) {
        const classResults = await tx.subjectResult.findMany({
          where: { classId: cohortClassId, termId: term.id, status: "PUBLISHED" },
          // subjectId rides along so the PER-SUBJECT class average, lowest and
          // highest cost nothing: the rows are already here for the overall
          // ranking, and a second pass over an array is free where a second
          // query over a term's marks is not.
          // status/total/grade ride along so a PUBLISHED mark reports the figure
          // it was published with rather than being recomputed on whatever the
          // school's policy says today (see reportedTermGrade).
          select: {
            studentId: true, subjectId: true, exam: true, midterm: true, assignment: true, classNote: true,
            status: true, total: true, grade: true,
          },
        });
        const byStudent = new Map<string, number[]>();
        // PER SUBJECT: what the class scored, so the row can carry the average,
        // the lowest and the highest beside the pupil's own mark. A parent
        // reading "65" learns something quite different when the class average is
        // 49 than when it is 82, and this is the same pass that ranks them.
        const bySubject = new Map<string, number[]>();
        for (const r of classResults) {
          const { total } = reportedTermGrade(
            {
              exam: r.exam, midterm: r.midterm, assignment: r.assignment, classNote: r.classNote,
              status: r.status, total: r.total, grade: r.grade,
            },
            grading?.components,
            bands,
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
        // ANNUAL POSITION PER SUBJECT — where this pupil stands in the subject
        // across the WHOLE year, which is the column the printed format sets
        // beside the annual grade. It needs every classmate's marks in every
        // term, so it is a second read; one query for the class's whole session
        // rather than one per subject or per term, and it is only run when there
        // is more than one term of marks to rank on. Like every other position
        // on this card it yields a number about THIS pupil — no other child's
        // marks or name is read out.
        if (annualTermNames.length > 1) {
          const sessionResults = (await tx.subjectResult.findMany({
            // `termId` is a scalar with a DB-level FK and no Prisma relation (the
            // documented pattern that keeps the models lean), so the session is
            // expressed as the ids the session report already resolved.
            where: { classId: cohortClassId, termId: { in: annualTermIds }, status: "PUBLISHED" },
            select: {
              studentId: true, subjectId: true, exam: true, midterm: true, assignment: true, classNote: true,
              status: true, total: true, grade: true,
            },
          })) as Array<{
            studentId: string;
            subjectId: string;
            exam: number | null;
            midterm: number | null;
            assignment: number | null;
            classNote: number | null;
            status: string;
            total: number | null;
            grade: string | null;
          }>;
          const perSubject = new Map<string, Map<string, number[]>>();
          for (const r of sessionResults) {
            const { total } = reportedTermGrade(
              {
                exam: r.exam, midterm: r.midterm, assignment: r.assignment, classNote: r.classNote,
                status: r.status, total: r.total, grade: r.grade,
              },
              grading?.components,
              bands,
            );
            const forSubject = perSubject.get(r.subjectId) ?? new Map<string, number[]>();
            forSubject.set(r.studentId, [...(forSubject.get(r.studentId) ?? []), total]);
            perSubject.set(r.subjectId, forSubject);
          }
          for (const [subjectId, forSubject] of perSubject) {
            const ranked = [...forSubject.entries()]
              .map(([sid, totals]) => ({ sid, avg: averageOf(totals) }))
              .filter((x): x is { sid: string; avg: number } => x.avg !== null)
              .sort((a, b) => b.avg - a.avg);
            if (!ranked.some((x) => x.sid === studentId)) continue;
            // Standard competition ranking, the same rule as every other
            // position on the card: ties share a place.
            let pos = 0, seen = 0, prev: number | null = null;
            for (const x of ranked) {
              seen += 1;
              if (prev === null || x.avg !== prev) { pos = seen; prev = x.avg; }
              if (x.sid === studentId) break;
            }
            annualPosition.set(subjectId, { position: pos, of: ranked.length });
          }
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
        //
        // The class the TERM was spent in, for the same reason the positions
        // above use it: after a mid-session move, counting the destination
        // class's register days gives a denominator from a term this pupil did
        // not sit there, and the numerator below is their own attendance.
        if (cohortClassId) {
          const sessions = await tx.attendanceSession.findMany({
            where: {
              classId: cohortClassId,
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
        annualPosition: Object.fromEntries(annualPosition),
        bands,
        // THE CUMULATIVE SCORE — every term's marks added together, which is the
        // figure the printed format sets beside the cumulative position. The
        // card already showed a cumulative AVERAGE; a school that reads the
        // total off the page was doing the arithmetic itself.
        cumulativeScore: [...annualBySubject.values()]
          .flat()
          .reduce<number>((n, v) => n + (v ?? 0), 0),
        studentName: student.name,
        schoolName: school?.name ?? "",
        termBegins,
        termEnds,
        nextTermBegins,
        daysOpened,
        traitRatings,
        totalTermScore,
        admissionNumber: profile?.admissionNumber ?? null,
        gender: profile?.gender ?? null,
        guardianNames,
        className: cohortClassName,
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
      /** Each remark with the name of whoever signed it — see the render block. */
      remarks: {
        classTeacher: { text: string; byName: string | null } | null;
        head: { text: string; byName: string | null; label: string } | null;
      };
      /** Named on the card the way the printed format names them. */
      guardianNames: string[];
      gender: string | null;
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
      /** subjectId → the pupil's place in that subject across the whole year. */
      annualPosition: Record<string, { position: number; of: number }>;
      /** The recorded promotion decision, or null when nobody has taken one. */
      promotionLine: string | null;
      /** The school's own grade scale — what the key at the foot of the card states. */
      bands: readonly GradeBand[];
      /** Every term's marks added together — the printed format's cumulative score. */
      cumulativeScore: number;
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

      // PERSONAL DATA — the identifying block. Sex is on it because the printed
      // format carries it and because two pupils in a year group share a name
      // more often than schools expect.
      doc.fontSize(11).text(`Student: ${d.studentName}`, startX);
      const idLine = [
        d.admissionNumber ? `Admission no.: ${d.admissionNumber}` : null,
        d.gender ? `Sex: ${d.gender}` : null,
        d.className ? `Class: ${d.className}` : null,
      ].filter(Boolean);
      if (idLine.length) doc.text(idLine.join("    "), startX);
      doc.text(`Generated: ${new Date().toLocaleString()}`, startX);
      doc.moveDown(0.8);

      // Term-weighted subject table.
      // Eight columns now (Pos added). Re-spaced rather than squeezed on the
      // end: the last column runs to 545, so appending without re-spacing would
      // have pushed Grade off the page edge.
      const colX = [startX, 168, 210, 252, 296, 336, 386, 432, 486];
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
      // The REMARK column is the grade in a word. The printed format carries
      // both because a letter is a code and a family reading "B3" cannot tell
      // whether their child did well; the word is the school's own, from its own
      // scale, never invented here.
      drawRow(["Subject", "C.A.", "Exam", "Total", "Grade", "Pos", "Class avg", "Low/High", "Remark"], true);
      doc.moveTo(startX, doc.y).lineTo(545, doc.y).strokeColor("#ccc").stroke();
      doc.moveDown(0.3);
      // WHAT EACH COLUMN IS OUT OF, stated in the table rather than only as a
      // sentence at the foot. A mark means nothing without its denominator, and
      // a parent reading "37" under Exam should not have to find a note three
      // inches below to learn it was out of 60.
      const caMax = GRADE_COMPONENTS.filter((c) => c.key !== "exam").reduce((n, c) => n + c.max, 0);
      doc.fillColor("#666");
      drawRow(["Maximum mark", String(caMax), String(gradeComponentMax("exam")), "100", "", "", "", "", ""], false);
      doc.fillColor("#000");
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
            sub.total === null ? "" : (gradeDescriptor(sub.total, d.bands) ?? ""),
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
        .map((s) => ({
          name: s.subjectName,
          totals: d.annualBySubject[s.subjectId] ?? [],
          rank: d.annualPosition[s.subjectId] ?? null,
        }))
        .filter((r) => r.totals.filter((t) => t !== null).length > 1);
      if (annualTerms.length > 1 && annualRows.length > 0) {
        doc.moveDown(0.8).fontSize(14).font("Helvetica-Bold").text("The year so far", startX);
        doc.moveDown(0.2).fontSize(9);
        // Annual average, its GRADE and the word for it — the same three things
        // the term columns above carry, so a parent can read the year the way
        // they just read the term rather than being handed a bare number.
        // Widths are DERIVED from how many terms there are, not fixed: a school
        // on a four-quarter calendar has four columns, and a fixed width sized
        // for three silently clipped the headings — "Second Term" printed as
        // "Second Te". The names are also shortened to fit rather than being cut
        // off mid-word by the renderer.
        const tailW = [58, 34, 42, 62];
        const subjectW = 112;
        const termW = Math.max(
          38,
          Math.floor((545 - startX - subjectW - tailW.reduce((a, b) => a + b, 0)) / Math.max(1, annualTerms.length)),
        );
        const fit = (label: string, width: number) => {
          doc.fontSize(9).font("Helvetica-Bold");
          if (doc.widthOfString(label) <= width - 4) return label;
          let out = label;
          while (out.length > 1 && doc.widthOfString(out + "\u2026") > width - 4) out = out.slice(0, -1);
          return out + "\u2026";
        };
        const aw = [subjectW, ...annualTerms.map(() => termW), ...tailW];
        const ax = aw.map((_, i) => startX + aw.slice(0, i).reduce((a, b) => a + b, 0));
        const arow = (cells: string[], bold: boolean) => {
          doc.font(bold ? "Helvetica-Bold" : "Helvetica");
          const y = doc.y;
          cells.forEach((c, i) => doc.text(c, ax[i], y, { width: aw[i] - 4, lineBreak: false }));
          doc.y = y + 13;
        };
        // EVERY heading is fitted, not just the term names: a heading silently
        // cut to "Annual av" is the same defect as a clipped term, and the next
        // person to re-balance these columns should not have to remember which
        // ones were protected.
        const aHead = ["Subject", ...annualTerms, "Annual avg", "Grade", "Pos", "Remark"];
        arow(aHead.map((h, i) => fit(h, aw[i])), true);
        for (const r of annualRows) {
          const present = r.totals.filter((t): t is number => t !== null);
          // The average counts the terms that HAVE marks — a missing term is an
          // absent measurement, and treating it as a zero would print a failure
          // the pupil never earned.
          const avg = present.length > 0 ? Math.round(present.reduce((a, b) => a + b, 0) / present.length) : null;
          arow(
            [
              r.name,
              ...r.totals.map((t) => (t === null ? "—" : String(t))),
              fmt(avg),
              avg === null ? "—" : gradeLetter(avg, d.bands),
              r.rank ? `${r.rank.position}/${r.rank.of}` : "—",
              avg === null ? "" : (gradeDescriptor(avg, d.bands) ?? ""),
            ],
            false,
          );
        }
        if (d.cumulativeScore > 0) {
          doc.moveDown(0.3).fontSize(10).font("Helvetica-Bold")
            .text(`Cumulative score: ${d.cumulativeScore}`, startX);
          doc.font("Helvetica");
        }
      }

      // THE GRADE KEY. Without it every letter above is unreadable: a parent
      // handed "B3" has no way to know whether it is good, and a card that
      // cannot be read has not really reported anything. Printed from the
      // SCHOOL's own scale, which is the same one the letters were computed on.
      if (d.bands.length > 0) {
        doc.moveDown(0.7).fontSize(10).font("Helvetica-Bold").text("Grades", startX);
        doc.moveDown(0.15).fontSize(8).font("Helvetica").fillColor("#555");
        const key = d.bands.map((b, i) => {
          const ceiling = i === 0 ? 100 : d.bands[i - 1].min - 1;
          return `${b.grade} ${b.min}\u2013${ceiling}${b.label ? ` ${b.label.toLowerCase()}` : ""}`;
        });
        doc.text(key.join("   |   "), startX, undefined, { width: 545 - startX });
        doc.fillColor("#000").fontSize(10);
      }

      // =======================================================================
      // REMARKS AND CONCLUSION — the signed half of the document
      // =======================================================================
      // Everything above is arithmetic the system performed. Everything here is
      // a judgement a PERSON made, and the printed format treats the two
      // differently: each comment sits over a signature rule and the name of
      // whoever wrote it, and the promotion decision is stamped beside the
      // principal's words rather than floating on its own.
      //
      // The names come from `classTeacherId` / `headId`, which this table has
      // stamped since it was created and which no reader had ever looked at —
      // so the card used to print a comment about a child with nobody's name
      // against it. An unattributed remark reads as the school speaking
      // collectively, which is not what happened and not something a parent can
      // reply to.
      const rule = (x: number, width: number) => {
        doc.moveTo(x, doc.y).lineTo(x + width, doc.y).strokeColor("#999").lineWidth(0.5).stroke().strokeColor("#000");
      };
      if (d.remarks.classTeacher || d.remarks.head || d.promotionLine) {
        doc.moveDown(0.9).fontSize(13).font("Helvetica-Bold").text("Remarks and conclusion", startX);

        if (d.remarks.classTeacher) {
          doc.moveDown(0.35).fontSize(9).font("Helvetica-Bold").fillColor("#555").text("CLASS TEACHER'S COMMENTS", startX);
          doc.fillColor("#000").fontSize(11).font("Helvetica-Oblique")
            .text(d.remarks.classTeacher.text, startX, undefined, { width: 495 - startX });
          doc.moveDown(0.9);
          rule(startX, 240);
          doc.moveDown(0.15).fontSize(8).font("Helvetica").fillColor("#666")
            .text(d.remarks.classTeacher.byName ?? "Class teacher", startX);
          doc.fillColor("#000");
        }

        if (d.remarks.head) {
          doc.moveDown(0.5).fontSize(9).font("Helvetica-Bold").fillColor("#555")
            .text(d.remarks.head.label.toUpperCase(), startX);
          doc.fillColor("#000");
          // The decision is stamped BESIDE the words, as the printed format has
          // it — the comment and the outcome are one statement, and separating
          // them lets a card be read as praising a child it is holding back.
          const y = doc.y + 2;
          let textX = startX;
          if (d.promotionLine) {
            const w = doc.fontSize(10).font("Helvetica-Bold").widthOfString(d.promotionLine) + 12;
            doc.rect(startX, y, w, 16).lineWidth(0.8).strokeColor("#000").stroke();
            doc.text(d.promotionLine, startX + 6, y + 4);
            textX = startX + w + 10;
          }
          doc.fontSize(11).font("Helvetica-Oblique")
            .text(d.remarks.head.text, textX, y + 3, { width: 495 - textX });
          doc.moveDown(0.9);
          rule(startX, 240);
          doc.moveDown(0.15).fontSize(8).font("Helvetica").fillColor("#666")
            .text(d.remarks.head.byName ?? "Head teacher", startX);
          doc.fillColor("#000");
        }

        // A decision with no comment beside it still has to appear.
        if (d.promotionLine && !d.remarks.head) {
          doc.moveDown(0.5).fontSize(11).font("Helvetica-Bold").text(d.promotionLine, startX);
          doc.font("Helvetica").fontSize(10);
        }

        // School stamp and date — the block a school physically signs.
        doc.moveDown(1.1);
        const stampX = 320;
        rule(stampX, 225);
        doc.moveDown(0.15).fontSize(8).font("Helvetica").fillColor("#666")
          .text("Signature, school stamp and date", stampX);
        doc.fillColor("#000");
      }

      if (d.guardianNames.length > 0) {
        doc.moveDown(0.5).fontSize(9).font("Helvetica").fillColor("#666")
          .text(`Parent / guardian: ${d.guardianNames.join(", ")}`, startX)
          .fillColor("#000");
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
      // SECURITY: ACTIVE only. Without the status filter this asked "was this
      // pupil EVER in a class I teach", so a teacher kept access to a pupil who
      // had since withdrawn, transferred or been promoted out — indefinitely,
      // and to their records rather than merely their name. Proven live: a
      // pupil was set to WITHDRAWN and their old teacher still fetched a signed
      // download URL for their report card. Whole-school staff are unaffected,
      // so the school can still produce a departed pupil's paperwork.
      const enr = await tx.enrollment.findFirst({
        where: { studentId, status: "ACTIVE", classId: { in: taught.map((t: { classId: string }) => t.classId) } },
        select: { id: true },
      });
      if (enr) return;
    }
    throw new NotFoundException("Student not found");
  }
}
