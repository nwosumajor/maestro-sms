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
import { classIdsTaughtBy } from "../common/teaches";
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
import { TRAIT_GROUPS, TRAIT_KEYS, TRAIT_SCALE, traitLabel, reportedTermGrade, averageOf, sessionAverageScope, resolveGradeBands, gradeLetter, gradeDescriptor, gradeWordFor, attendanceRatePct } from "@sms/types";
import { GRADE_COMPONENTS, gradeComponentMax } from "@sms/types";
import type { GradeBand, GradeComponentKey } from "@sms/types";
import { effectiveComponents } from "@sms/types";
import { SchoolRegionService } from "../foundation/school-region.service";
import type { TermSubjectRowDto } from "@sms/types";
import { createPdfDocument } from "../common/pdf-document";
import { publicWebUrl } from "../common/public-url";
import { drawQrCode } from "../certificate/qr";
import { ReportCardAttestationService, formatAttestationCode } from "./report-card-attestation.service";

const STAFF_WIDE = new Set(["school_admin", "principal"]);

/** Everything one report card prints. */
type ReportCardData = {
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
      /** The academic year, as the letterhead names it ("2025/2026"). */
      sessionName: string | null;
      /** subjectId → that subject's total in each of those terms (null = no marks). */
      annualBySubject: Record<string, Array<number | null>>;
      /** subjectId → the pupil's place in that subject across the whole year. */
      annualPosition: Record<string, { position: number; of: number }>;
      /** The recorded promotion decision, or null when nobody has taken one. */
      promotionLine: string | null;
      /** The school's own grade scale — what the key at the foot of the card states. */
      bands: readonly GradeBand[];
      /** The school's own WEIGHTING — what each column is out of, and the note at
       *  the foot. Carried for exactly the reason `bands` is: both are fields of
       *  the SAME policy object, the card already computed with this one, and it
       *  printed the platform's default instead. */
      components: ReadonlyArray<{ key: string; label: string; max: number }>;
      /** Every term's marks added together — the printed format's cumulative score. */
      cumulativeScore: number;
      /** WHAT THE CARD CARRIES INSTEAD OF A SIGNATURE — a named approver, the
       *  date, and a code the holder can check. Null when nobody has signed:
       *  no head remark means no attestation, and a block claiming one would be
       *  the very thing this is here to prevent. */
      attestation: {
        code: string;
        version: number;
        approvedByName: string;
        approvedByRole: string;
        approvedAt: Date;
        verifyUrl: string;
      } | null;
};

/** The pdfkit document `createPdfDocument` hands back, whose text is folded
 *  for WinAnsi — see `common/pdf-document.ts`. */
type PdfDocument = ReturnType<typeof createPdfDocument>;

@Injectable()
export class ReportCardService {
  private readonly logger = new Logger("ReportCard");

  constructor(
    @Inject(TENANT_DATABASE) private readonly db: TenantDatabase,
    @Inject(AUDIT_LOG_SERVICE) private readonly audit: AuditLogService,
    private readonly branding: BrandingService,
    private readonly attestations: ReportCardAttestationService,
    private readonly documents: DocumentsService,
    private readonly remarks: ReportCardRemarkService,
    private readonly termResults: TermResultService,
    private readonly region: SchoolRegionService,
  ) {}

  private ctx(p: Principal): TenantContext {
    return { schoolId: p.schoolId, userId: p.userId };
  }

  async generate(
    p: Principal,
    studentId: string,
    termId?: string,
  ): Promise<{ buffer: Buffer; filename: string; filedToVault: boolean; unpublishedMarks: number }> {
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
    let sessionName: string | null = null;
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

      sessionName = report.sessionName ?? null;
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
      const school = await tx.school.findFirst({ where: { id: p.schoolId }, select: { name: true, slug: true } });
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

      // Attendance summary — SCOPED to the term's date window.
      //
      // On the RECORD's own `date`, not the session's: the table is partitioned
      // on it, so this prunes to the term's months instead of scanning every
      // partition the school has ever written. Equivalent by construction.
      const recs = await tx.attendanceRecord.findMany({
        where: {
          studentId,
          ...(term?.startDate && term?.endDate
            ? { date: { gte: term.startDate, lte: term.endDate } }
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
      if (term) {
        // FOUND BY THE PUPIL'S MEMBERSHIP OF THE BATCH, not by the class they are
        // in now.
        //
        // This filtered on `sourceClassId: enrolment.classId`, and `enrolment` is
        // the pupil's ACTIVE one. Approving a promotion marks the source
        // enrolment PROMOTED and opens a new ACTIVE one in the TARGET class — so
        // for a pupil who WAS promoted the source class no longer matches and the
        // line never printed. A pupil who was RETAINED stays ACTIVE in the source
        // class, so theirs did.
        //
        // The asymmetry is the whole defect: THE ONLY CARDS CARRYING A PROMOTION
        // LINE WERE THE ONES WITH BAD NEWS. Measured live on a batch of 30 — the
        // retained pupil's card read "TO REPEAT THE CLASS" and all 29 promoted
        // cards said nothing at all.
        //
        // A DEMOTE moves the pupil too, so it was silent for the same reason.
        //
        // The batch is still narrowed by TERM and by APPROVED, so a staged or
        // rejected batch prints nothing and a decision from another term cannot
        // leak onto this card. `studentIds` is the batch's own record of who was
        // in it, which is what the outcome was decided about.
        const batches = (await tx.promotionBatch.findMany({
          where: { termId: term.id, status: "APPROVED" },
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

      // ISSUED IN THE SAME TRANSACTION that assembled the card, so the code
      // printed on the page and the row it resolves to cannot disagree.
      const issued = term
        ? await this.attestations.issueInTx(tx, {
            schoolId: p.schoolId,
            studentId,
            termId: term.id,
            termAverage,
            termGrade,
            subjects: subjectRows.map((r) => ({ subject: r.subjectName, total: r.total ?? null, grade: r.grade ?? null })),
          })
        : null;

      return {
        attestation: issued
          ? { ...issued, verifyUrl: `${publicWebUrl()}/verify/card/${school?.slug ?? ""}/${issued.code}` }
          : null,
        promotionLine,
        annualTermNames,
        sessionName,
        annualBySubject: Object.fromEntries(annualBySubject),
        annualPosition: Object.fromEntries(annualPosition),
        bands,
        components: grading?.components ?? GRADE_COMPONENTS,
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
    // THE TERM BELONGS IN THE NAME.
    //
    // This was `report-card-<pupil>.pdf` whatever term was asked for, and the
    // SAME string is the Document Vault title below — so a pupil's three cards
    // for a session were filed under one identical name, and a family opening
    // their vault could not tell Term 1 from Term 3. A principal printing a
    // year's cards got three downloads the browser numbered (1), (2), (3).
    //
    // The card itself has always named the term in its heading; only the thing
    // you file it under did not.
    const slug = (v: string) => v.replace(/[^a-zA-Z0-9]+/g, "-").replace(/^-+|-+$/g, "").toLowerCase();
    const filename = [
      "report-card",
      slug(data.studentName),
      data.termName ? slug(data.termName) : null,
    ]
      .filter(Boolean)
      .join("-")
      .concat(".pdf");

    // THE VAULT COPY IS THE FAMILY'S, AND MUST NOT CARRY A MARK THEY MAY NOT SEE.
    //
    // This card is rendered with the CALLER's scope, and the scope rule one
    // method up is explicit: "student→self, parent→children PUBLISHED-only,
    // staff-of-class all". So a staff member printing before publication gets a
    // PDF containing DRAFT marks — correct for them — and that exact buffer was
    // then filed into the pupil's vault, where `uploadBytes` NOTIFIES THE
    // GUARDIANS. Measured on a real pupil: the stored card carried Chemistry 83,
    // Civic Education 49, Economics 60 and English Language 78, none of them
    // published.
    //
    // That defeats the GRADE_PUBLISH maker-checker for the one artifact it
    // exists to protect. Two people approve a mark precisely so a family does
    // not see it before then, and the card walked round the gate — not by
    // reading, but by DELIVERING.
    //
    // The restrictive option (Golden Rule #7): the caller still gets their own
    // full PDF, and nothing is filed until every one of the term's marks is
    // published. That matches the workflow — a school issues cards after
    // publishing — and the caller is TOLD rather than left to assume a copy went
    // out. The fuller answer is to render the vault copy a SECOND time under a
    // forced published-only scope, which needs `getStudentSessionReport` to take
    // an explicit tightening flag; it is named here rather than half-built.
    const unpublished = term
      ? await this.db.runAsTenant(this.ctx(p), (tx) =>
          tx.subjectResult.count({
            where: { studentId, termId: term.id, status: { not: "PUBLISHED" } },
          }),
        )
      : 0;
    if (unpublished > 0) {
      this.logger.warn(
        `report card for ${studentId} NOT filed to the vault: ${unpublished} of the term's marks are not published yet`,
      );
      return { buffer, filename, filedToVault: false, unpublishedMarks: unpublished };
    }

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

    return { buffer, filename, filedToVault: true, unpublishedMarks: 0 };
  }

  /**
   * Draw ONE card onto an open document.
   *
   * Split out so a whole class prints as a SINGLE multi-page PDF. The
   * console's "Print all" fired one blob download per pupil, and a browser
   * throttles or blocks repeated programmatic downloads — so "Printed 30" was
   * a claim the page could not observe, which is the silent-partial-success
   * shape this codebase keeps finding. One file cannot half-arrive.
   *
   * It draws and returns; opening, paging and ending the document belong to the
   * caller, which is what lets the pack put a page break between pupils.
   */
  /**
   * THE PRINTED FORMAT, as Nigerian schools actually issue it.
   *
   * Laid out from a real Continuous Assessment Report: everything sits in a
   * bordered box under a titled bar, and the page reads as a FORM rather than a
   * flowing document. That is not decoration — a card is read across, by a
   * parent looking for one subject's row and one figure, and whitespace between
   * free-standing headings made ours slower to scan the more it carried.
   *
   * Section order is the reference's: identity and attendance side by side, the
   * rating key BEFORE the ratings that use it, the grade key BEFORE the marks
   * that use it, then academic performance, then the signed conclusion.
   */
  private drawCard(doc: PdfDocument, d: ReportCardData, logo?: Buffer | null): void {
      // The reference is portrait and dense; 28pt margins buy the width the
      // academic table needs without going landscape.
      const L = 28;
      const R = 567;
      const W = R - L;
      const fmt = (n: number | null): string => (n === null || n === undefined ? "—" : String(n));
      const INK = "#000";
      const RULE = "#333";
      const FAINT = "#f2f2f2";

      const rect = (x: number, y: number, w: number, h: number, fill?: string) => {
        if (fill) doc.rect(x, y, w, h).fillColor(fill).fill();
        doc.rect(x, y, w, h).lineWidth(0.6).strokeColor(RULE).stroke();
        doc.fillColor(INK);
      };
      /** Text inside a cell, vertically centred, never spilling past its box. */
      const cellText = (
        t: string,
        x: number,
        y: number,
        w: number,
        h: number,
        o: { bold?: boolean; size?: number; align?: "left" | "center" | "right"; color?: string; wrap?: boolean } = {},
      ) => {
        const size = o.size ?? 6.6;
        doc.font(o.bold ? "Helvetica-Bold" : "Helvetica").fontSize(size).fillColor(o.color ?? INK);
        // A CELL HOLDING A SENTENCE MUST WRAP. `lineBreak: false` is right for a
        // table cell — a mark or a grade that no longer fits should ellipsize
        // visibly rather than reflow the row — and wrong for the message cells,
        // where it silently truncated "No attendance was recorded for this
        // student, though the register was taken on 49 days." to its first line.
        const th = doc.heightOfString(t || " ", { width: w - 4 });
        doc.text(t ?? "", x + 2, y + Math.max(0.5, (h - th) / 2), {
          width: w - 4,
          align: o.align ?? "center",
          lineBreak: o.wrap ?? false,
          ellipsis: !o.wrap,
        });
        doc.fillColor(INK);
      };
      /** A titled section bar. Returns the y beneath it. */
      const bar = (x: number, y: number, w: number, title: string, h = 12): number => {
        rect(x, y, w, h, FAINT);
        cellText(title, x, y, w, h, { bold: true, size: 7.4 });
        return y + h;
      };
      /** One row of cells with their own borders. Returns the y beneath. */
      const row = (
        x: number,
        y: number,
        widths: number[],
        cells: string[],
        o: { h?: number; bold?: boolean; size?: number; fill?: string; align?: "left" | "center" | "right"; wrap?: boolean } = {},
      ): number => {
        const h = o.h ?? 11;
        let cx = x;
        widths.forEach((w, i) => {
          rect(cx, y, w, h, o.fill);
          cellText(cells[i] ?? "", cx, y, w, h, { bold: o.bold, size: o.size, align: o.align, wrap: o.wrap });
          cx += w;
        });
        return y + h;
      };
      /** Shorten a heading VISIBLY rather than letting the renderer clip it —
       *  "Annual av" with no ellipsis reads as the name of the column. */
      const fit = (label: string, width: number, size = 6.4): string => {
        doc.font("Helvetica-Bold").fontSize(size);
        if (doc.widthOfString(label) <= width - 4) return label;
        let out = label;
        while (out.length > 1 && doc.widthOfString(out + "…") > width - 4) out = out.slice(0, -1);
        return out + "…";
      };

      let y = 30;

      // =====================================================================
      // 1. LETTERHEAD — crest, school, and the term this card is for
      // =====================================================================
      const badgeW = 64;
      if (logo) {
        try {
          doc.image(logo, L + 4, y + 2, { fit: [40, 40] });
        } catch {
          /* ignore unsupported/corrupt image */
        }
      }
      const headW = W - badgeW - 6;
      doc.font("Helvetica-Bold").fontSize(15).fillColor(INK)
        .text(d.schoolName || "Report Card", L + 46, y + 2, { width: headW - 46, align: "center" });
      const sub = [d.termName, d.sessionName].filter(Boolean).join(" · ");
      // What this product calls the document. The reference's own letterhead says
      // "Continuous Assessment Report" because that is what THAT school calls it;
      // copying the words along with the layout renamed everyone else's card.
      doc.font("Helvetica").fontSize(7.5).fillColor("#444")
        .text("Report Card", L + 46, y + 21, { width: headW - 46, align: "center" });
      doc.fontSize(7).text(sub, L + 46, y + 31, { width: headW - 46, align: "center" });
      doc.fillColor(INK);

      // The class and the term, boxed at the top right exactly as the reference
      // carries them: the two things somebody sorting a stack of cards reads.
      const bx = R - badgeW;
      rect(bx, y, badgeW, 21);
      cellText(d.className ?? "—", bx, y, badgeW, 21, { bold: true, size: 10 });
      rect(bx, y + 21, badgeW, 20, FAINT);
      cellText((d.termName ?? "TERM").toUpperCase(), bx, y + 21, badgeW, 20, { bold: true, size: 7.5 });
      y += 46;

      // =====================================================================
      // 2. PERSONAL DATA | ATTENDANCE + TERMINAL DURATION, side by side
      // =====================================================================
      const leftW = Math.round(W * 0.46);
      const rightW = W - leftW;
      const rx = L + leftW;

      let ly = bar(L, y, leftW, "STUDENT'S PERSONAL DATA");
      const labelW = Math.round(leftW * 0.34);
      const idRows: Array<[string, string]> = [
        ["NAME", d.studentName],
        ["ADMISSION NO.", d.admissionNumber ?? "—"],
        ["SEX", d.gender ?? "—"],
        ["CLASS", d.className ?? "—"],
      ];
      for (const [k, v] of idRows) {
        rect(L, ly, labelW, 11, FAINT);
        cellText(k, L, ly, labelW, 11, { bold: true, size: 6.2, align: "left" });
        rect(L + labelW, ly, leftW - labelW, 11);
        cellText(v, L + labelW, ly, leftW - labelW, 11, { size: 6.8, align: "left" });
        ly += 11;
      }

      // ATTENDANCE. The denominator comes FIRST: "present 46" means nothing
      // without the number of days the school actually opened.
      let ry = bar(rx, y, rightW, "ATTENDANCE");
      const a3 = [Math.round(rightW / 3), Math.round(rightW / 3), rightW - 2 * Math.round(rightW / 3)];
      const attTotal = d.att.PRESENT + d.att.LATE + d.att.ABSENT + d.att.EXCUSED;
      // Only when there is something under them. A label row over an empty box is
      // the same defect as a trait group heading with no ratings beneath it,
      // which this card already refuses.
      if (attTotal > 0 || d.daysOpened > 0) {
        ry = row(rx, ry, a3, ["Times Sch. Opened", "Times Present", "Times Absent"], { bold: true, size: 5.9, fill: FAINT, h: 10 });
      }
      // FOUR ZEROS ARE A STATEMENT ABOUT THE CHILD; NO REGISTER IS A STATEMENT
      // ABOUT THE SCHOOL. A parent seeing four zeros reads "my child was never
      // present"; the truth is usually that no register has been taken yet.
      if (attTotal > 0) {
        ry = row(rx, ry, a3, [
          d.daysOpened > 0 ? `Times school opened: ${d.daysOpened}` : "—",
          `Present: ${d.att.PRESENT}`,
          `Absent: ${d.att.ABSENT}`,
        ], { size: 6.4, h: 11 });
        ry = row(rx, ry, a3, ["Times Late", "Times Excused", "Attendance Rate"], { bold: true, size: 5.9, fill: FAINT, h: 10 });
        ry = row(rx, ry, a3, [
          `Late: ${d.att.LATE}`,
          `Excused: ${d.att.EXCUSED}`,
          `Attendance rate: ${attendanceRatePct({ present: d.att.PRESENT, late: d.att.LATE, absent: d.att.ABSENT, excused: d.att.EXCUSED })}%`,
        ], { size: 6.4, h: 11 });
      } else if (d.daysOpened > 0) {
        // The register WAS taken and this pupil is in none of it — a different
        // fact from the one below, and one the school can act on. The opened
        // count stays: it is the figure that gives the absence its meaning.
        ry = row(rx, ry, [a3[0], rightW - a3[0]], [
          `Times school opened: ${d.daysOpened}`,
          `No attendance was recorded for this student, though the register was taken on ${d.daysOpened} day${d.daysOpened === 1 ? "" : "s"}.`,
        ], { size: 6.2, h: 22, wrap: true });
      } else {
        ry = row(rx, ry, [rightW], ["No attendance has been recorded for this term."], { size: 6.4, h: 22, wrap: true });
      }

      const day = (v: Date | null) => (v ? new Date(v).toISOString().slice(0, 10) : null);
      ry = bar(rx, ry, rightW, "TERMINAL DURATION");
      ry = row(rx, ry, a3, ["Term Begins", "Term Ends", "Next Term Begins"], { bold: true, size: 5.9, fill: FAINT, h: 10 });
      ry = row(rx, ry, a3, [
        day(d.termBegins) ? `Term begins: ${day(d.termBegins)}` : "—",
        day(d.termEnds) ? `Term ends: ${day(d.termEnds)}` : "—",
        day(d.nextTermBegins) ? `Next term begins: ${day(d.nextTermBegins)}` : "—",
      ], { size: 6, h: 11 });

      y = Math.max(ly, ry);

      // =====================================================================
      // 3. THE RATING KEY — before the ratings that use it
      // =====================================================================
      // "4" tells a parent nothing on its own, and a number a family cannot
      // interpret is how a behavioural rating becomes an argument.
      if (d.traitRatings.length > 0) {
        y = bar(L, y, W, "KEYS TO RATINGS ON OBSERVABLE BEHAVIOUR");
        const half = Math.ceil(TRAIT_SCALE.length / 2);
        const line1 = TRAIT_SCALE.slice(0, half).map((r) => `${r.score} = ${r.label}`).join("   |   ");
        const line2 = TRAIT_SCALE.slice(half).map((r) => `${r.score} = ${r.label}`).join("   |   ");
        y = row(L, y, [W], [line1], { size: 5.9, h: 10 });
        y = row(L, y, [W], [line2], { size: 5.9, h: 10 });

        // =================================================================
        // 4. SKILLS AND BEHAVIOUR — the catalogue's groups, side by side
        // =================================================================
        y = bar(L, y, W, "SKILLS DEVELOPMENT AND BEHAVIOURAL ATTRIBUTES");
        const scoreOf = new Map(d.traitRatings.map((r) => [r.traitKey, r.score]));
        const groups: Array<{ label: string; items: Array<{ label: string; score: number }> }> = [];
        for (const g of TRAIT_GROUPS) {
          const items = g.traits
            .filter((t) => scoreOf.has(t.key))
            .map((t) => ({ label: t.label, score: scoreOf.get(t.key) as number }));
          // Never a group heading with nothing under it.
          if (items.length > 0) groups.push({ label: g.label.toUpperCase(), items });
        }
        // A RATING UNDER A RETIRED TRAIT STILL HAPPENED. This walks the
        // CATALOGUE, so a trait removed from TRAIT_GROUPS would take every
        // historical rating of it off every past card — silently, which is the
        // part that matters. `isTraitKey` refuses an unknown key on the way IN,
        // so these can only be rows the catalogue has moved on from.
        const retired = d.traitRatings.filter((r) => !TRAIT_KEYS.includes(r.traitKey));
        if (retired.length > 0) {
          groups.push({
            label: "OTHER RECORDED TRAITS",
            items: retired.map((r) => ({ label: traitLabel(r.traitKey), score: r.score })),
          });
        }
        if (groups.length > 0) {
          const gw = Math.floor(W / groups.length);
          const ptsW = 26;
          const rows = Math.max(...groups.map((g) => g.items.length));
          let hy = y;
          groups.forEach((g, gi) => {
            const gx = L + gi * gw;
            const wide = gi === groups.length - 1 ? W - gi * gw : gw;
            rect(gx, hy, wide - ptsW, 10, FAINT);
            cellText(fit(g.label, wide - ptsW, 5.8), gx, hy, wide - ptsW, 10, { bold: true, size: 5.8, align: "left" });
            rect(gx + wide - ptsW, hy, ptsW, 10, FAINT);
            cellText("POINTS", gx + wide - ptsW, hy, ptsW, 10, { bold: true, size: 5.2 });
          });
          hy += 10;
          for (let i = 0; i < rows; i += 1) {
            groups.forEach((g, gi) => {
              const gx = L + gi * gw;
              const wide = gi === groups.length - 1 ? W - gi * gw : gw;
              const it = g.items[i];
              rect(gx, hy, wide - ptsW, 9.5);
              cellText(it ? it.label : "", gx, hy, wide - ptsW, 9.5, { size: 5.8, align: "left" });
              rect(gx + wide - ptsW, hy, ptsW, 9.5);
              cellText(it ? String(it.score) : "", gx + wide - ptsW, hy, ptsW, 9.5, { size: 6.2, bold: true });
            });
            hy += 9.5;
          }
          y = hy;
        }
      }

      // =====================================================================
      // 5. THE GRADE KEY — before the marks that use it
      // =====================================================================
      // Without it every letter below is unreadable: a parent handed "B3" has no
      // way to know whether it is good, and a card that cannot be read has not
      // really reported anything. Printed from the SCHOOL's own scale. It is NOT
      // necessarily the one the letters were computed on — a published grade is
      // frozen and this key is today's — so the note below owns up when they
      // disagree.
      if (d.bands.length > 0) {
        y = bar(L, y, W, "GRADE");
        const keys = d.bands.map((b, i) => {
          const ceiling = i === 0 ? 100 : d.bands[i - 1].min - 1;
          return `${b.grade} ${b.min}–${ceiling}${b.label ? ` ${b.label.toLowerCase()}` : ""}`;
        });
        const perRow = Math.min(5, Math.max(3, Math.ceil(keys.length / 2)));
        for (let i = 0; i < keys.length; i += perRow) {
          const slice = keys.slice(i, i + perRow);
          const w = Math.floor(W / perRow);
          const widths = slice.map((_, j) => (j === slice.length - 1 && slice.length === perRow ? W - (perRow - 1) * w : w));
          y = row(L, y, widths, slice, { size: 5.9, h: 10 });
        }
        const defined = new Set(d.bands.map((b) => b.grade));
        const foreign = [...new Set(d.subjects.map((sx) => sx.grade).filter((g): g is string => !!g && !defined.has(g)))];
        if (foreign.length > 0) {
          y = row(L, y, [W], [
            `${foreign.join(", ")} below ${foreign.length === 1 ? "was" : "were"} awarded on the grading scale in force when the mark was published, and ${foreign.length === 1 ? "is" : "are"} not in the key above. The school's scale has changed since.`,
          ], { size: 5.6, h: 14, wrap: true });
        }
      }

      // =====================================================================
      // 6. ACADEMIC PERFORMANCE
      // =====================================================================
      y = bar(L, y, W, "ACADEMIC PERFORMANCE");

      // THE YEAR, alongside the term, as the reference sets them: the current
      // term's marks under MARKS OBTAINED and the session's shape under ANNUAL
      // SUMMARY. The annual half appears only once there is more than one term's
      // marks to compare — on a first-term card it would be the same column
      // twice.
      const annualTerms = d.annualTermNames;
      const annualRows = new Map(
        d.subjects.map((s) => [s.subjectId, {
          totals: d.annualBySubject[s.subjectId] ?? [],
          rank: d.annualPosition[s.subjectId] ?? null,
        }]),
      );
      const showAnnual =
        annualTerms.length > 1 &&
        [...annualRows.values()].some((r) => r.totals.filter((t) => t !== null).length > 1);
      // The PRIOR terms: the current term's own figures are in MARKS OBTAINED,
      // so repeating them here would be the same number twice. When the current
      // term is not among them (a calendar the card was not generated against)
      // every term is shown rather than none.
      const currentIdx = d.termName ? annualTerms.indexOf(d.termName) : -1;
      const priorIdx = annualTerms.map((_, i) => i).filter((i) => i !== currentIdx);

      const examMax = d.components.find((c) => c.key === "exam")?.max ?? gradeComponentMax("exam");
      const caMax = d.components.filter((c) => c.key !== "exam").reduce((n, c) => n + c.max, 0);

      const termHeads = ["C.A.", "Exam", "Total", "Grade", "Pos", "Class avg", "Low/High", "Remark"];
      const termW = [24, 24, 26, 26, 30, 36, 34, 40];
      const annHeads = showAnnual
        ? [...priorIdx.map((i) => annualTerms[i]), "Annual avg", "Grade", "Pos", "Remark"]
        : [];
      // The prior-term columns take WHAT IS LEFT rather than a fixed width, so a
      // three-term school's "Second Term" fits and a four-quarter school's
      // columns narrow until a heading has to be shortened — visibly, with an
      // ellipsis, rather than clipped mid-word.
      const annFixed = showAnnual ? [42, 26, 28, 36] : [];
      const spent = 76 + termW.reduce((a, b) => a + b, 0) + annFixed.reduce((a, b) => a + b, 0);
      const perTerm = showAnnual && priorIdx.length > 0
        ? Math.max(22, Math.floor((W - spent) / priorIdx.length))
        : 0;
      const annW = showAnnual ? [...priorIdx.map(() => perTerm), ...annFixed] : [];
      let widths = [76, ...termW, ...annW];
      // Scale to the page rather than running off it: a four-quarter school has
      // more columns than a three-term one, and the headings ellipsize rather
      // than being clipped mid-word.
      const sum = widths.reduce((a, b) => a + b, 0);
      if (sum > W) widths = widths.map((w) => (w * W) / sum);
      const xs = widths.map((_, i) => L + widths.slice(0, i).reduce((a, b) => a + b, 0));

      // Column-group banner, so a reader knows which half of the row is the term
      // and which is the year.
      const termSpan = widths.slice(1, 1 + termW.length).reduce((a, b) => a + b, 0);
      rect(L, y, widths[0], 10, FAINT);
      rect(L + widths[0], y, termSpan, 10, FAINT);
      cellText("MARKS OBTAINED", L + widths[0], y, termSpan, 10, { bold: true, size: 6 });
      if (showAnnual) {
        const annSpan = W - widths[0] - termSpan;
        rect(L + widths[0] + termSpan, y, annSpan, 10, FAINT);
        cellText("ANNUAL SUMMARY", L + widths[0] + termSpan, y, annSpan, 10, { bold: true, size: 6 });
      }
      y += 10;

      const heads = ["Subject", ...termHeads, ...annHeads];
      y = row(L, y, widths, heads.map((h, i) => fit(h, widths[i])), { bold: true, size: 6.4, fill: FAINT, h: 13 });

      // WHAT EACH COLUMN IS OUT OF, in the table rather than only as a sentence
      // at the foot. A mark means nothing without its denominator, and a parent
      // reading "37" under Exam should not have to find a note three inches
      // below to learn it was out of 60. THE SCHOOL'S OWN denominators.
      y = row(L, y, widths,
        ["Maximum mark", String(caMax), String(examMax), "100", "", "", "100", "", "",
          ...(showAnnual ? [...priorIdx.map(() => "100"), "100", "", "", ""] : [])],
        { size: 6, h: 10, fill: "#fafafa" });

      if (d.subjects.length === 0) {
        y = row(L, y, [W], ["No published grades for this term yet."], { size: 7, h: 14 });
      } else {
        for (const s of d.subjects) {
          // AS THEY COUNT, not as they were typed. The total is a sum of CLAMPED
          // components; printing the raw ones beside it gave a row that does not
          // add up.
          const eff = effectiveComponents(s, d.components as ReadonlyArray<{ key: GradeComponentKey; max: number }>);
          const ca = [s.midterm, s.assignment, s.classNote].some((v) => v !== null)
            ? (eff.midterm ?? 0) + (eff.assignment ?? 0) + (eff.classNote ?? 0)
            : null;
          // "3/28" reads better than a bare 3: a position is meaningless without
          // knowing how many were ranked.
          const pos = s.subjectPosition && s.subjectRanked ? `${s.subjectPosition}/${s.subjectRanked}` : "—";
          const lowHigh = s.classLowest != null && s.classHighest != null ? `${s.classLowest}/${s.classHighest}` : "—";
          const ann = annualRows.get(s.subjectId);
          let annCells: string[] = [];
          if (showAnnual) {
            const totals = ann?.totals ?? [];
            const present = totals.filter((t): t is number => t !== null);
            // The average counts the terms that HAVE marks — a missing term is
            // an absent measurement, and treating it as a zero would print a
            // failure the pupil never earned.
            const avg = present.length > 0 ? Math.round(present.reduce((x, z) => x + z, 0) / present.length) : null;
            annCells = [
              ...priorIdx.map((i) => (totals[i] === null || totals[i] === undefined ? "—" : String(totals[i]))),
              fmt(avg),
              avg === null ? "—" : gradeLetter(avg, d.bands),
              ann?.rank ? `${ann.rank.position}/${ann.rank.of}` : "—",
              avg === null ? "" : (gradeDescriptor(avg, d.bands) ?? ""),
            ];
          }
          const cells = [
            // An asterisk, not a footnote nobody reads: a total with a component
            // still unmarked counts that component as ZERO, so 24 can mean
            // "scored 24" or "only the class note is in".
            s.subjectName + (s.complete ? "" : " *"),
            fmt(ca),
            fmt(eff.exam),
            fmt(s.total),
            s.grade ?? "—",
            pos,
            fmt(s.classAverage ?? null),
            lowHigh,
            // THE WORD MUST DESCRIBE THE LETTER BESIDE IT, never a re-banding of
            // the total against today's scale while the Grade column shows the
            // letter the mark was PUBLISHED with.
            gradeWordFor(s.grade ?? null, d.bands) ?? "",
            ...annCells,
          ];
          let cx = L;
          widths.forEach((w, i) => {
            rect(cx, y, w, 10);
            cellText(cells[i] ?? "", cx, y, w, 10, { size: 6.2, align: i === 0 ? "left" : "center" });
            cx += w;
          });
          y += 10;
        }
      }

      // The figures the printed format carries along the foot of the table.
      const foot: string[] = [];
      if (d.classSize) foot.push(`NO. IN ROLL: ${d.classSize}`);
      if (d.totalTermScore > 0) foot.push(`Total term score: ${d.totalTermScore}`);
      if (d.cumulativeScore > 0) foot.push(`Cumulative score: ${d.cumulativeScore}`);
      foot.push(`Term average: ${fmt(d.termAverage)}${d.termGrade ? `  (${d.termGrade})` : ""}`);
      if (d.position && d.classSize) foot.push(`Position in class: ${d.position} of ${d.classSize}`);
      const fw = Math.floor(W / foot.length);
      y = row(L, y, foot.map((_, i) => (i === foot.length - 1 ? W - (foot.length - 1) * fw : fw)), foot,
        { bold: true, size: 6.2, h: 12, fill: FAINT });
      if (d.sessionAverage !== null) {
        // Name the terms it covers rather than claiming "all terms so far": a
        // school that onboarded in Term 2 has no Term 1 marks.
        const scope = sessionAverageScope(d.sessionTermsCounted, d.sessionTermsTotal);
        y = row(L, y, [W], [`Cumulative session average (${scope}): ${d.sessionAverage}`], { size: 6.2, h: 10 });
      }
      // Said once, plainly, and only when it applies — a standing disclaimer on
      // every report card is one nobody reads.
      if (d.subjects.some((sx) => !sx.complete)) {
        y = row(L, y, [W], [
          "* Not every component has been marked for this subject yet. Unmarked components count as zero, so this total is provisional.",
        ], { size: 5.6, h: 10, wrap: true });
      }

      // =====================================================================
      // 7. REMARKS AND CONCLUSION — the signed half of the document
      // =====================================================================
      // Everything above is arithmetic the system performed. Everything here is
      // a judgement a PERSON made, and the format treats the two differently:
      // each comment sits beside the name of whoever wrote it.
      //
      // The names come from `classTeacherId` / `headId`. An unattributed remark
      // reads as the school speaking collectively, which is not what happened
      // and not something a parent can reply to.
      y = bar(L, y, W, "REMARKS AND CONCLUSION");
      const signW = 150;
      const commentW = W - signW;
      const commentRow = (title: string, text: string, signTitle: string, signName: string | null, h: number) => {
        rect(L, y, commentW, h);
        doc.font("Helvetica-Bold").fontSize(6).fillColor("#555").text(title, L + 4, y + 3, { width: commentW - 8 });
        doc.font("Helvetica").fontSize(7).fillColor(INK)
          .text(text, L + 4, y + 12, { width: commentW - 8, height: h - 15, ellipsis: true });
        rect(L + commentW, y, signW, h);
        doc.font("Helvetica-Bold").fontSize(5.6).fillColor("#555")
          .text(signTitle, L + commentW + 4, y + 3, { width: signW - 8, align: "center" });
        if (signName) {
          doc.font("Helvetica").fontSize(6.6).fillColor(INK)
            .text(signName, L + commentW + 4, y + h - 12, { width: signW - 8, align: "center" });
        }
        doc.fillColor(INK);
        y += h;
      };

      if (d.remarks.classTeacher) {
        commentRow(
          "CLASS TEACHER'S COMMENTS",
          d.remarks.classTeacher.text,
          "Signature (Class Teacher)",
          d.remarks.classTeacher.byName ?? "Class teacher",
          40,
        );
      }
      if (d.remarks.head || d.promotionLine) {
        const label = (d.remarks.head?.label ?? "Head teacher's comments").toUpperCase();
        // The promotion decision is stamped BESIDE the head's words rather than
        // floating on its own — it is the conclusion those words explain.
        const text = [d.promotionLine ? `[ ${d.promotionLine} ]` : null, d.remarks.head?.text ?? null]
          .filter(Boolean)
          .join("   ");
        commentRow(label, text, "Signature, school stamp and date", d.remarks.head?.byName ?? "Head teacher", 40);
      }
      if (d.guardianNames.length > 0) {
        y = row(L, y, [W], [`Parent / guardian: ${d.guardianNames.join(", ")}`], { size: 6.4, h: 11, align: "left" });
      }

      // =====================================================================
      // THE ATTESTATION — what this card carries INSTEAD of a signature
      // =====================================================================
      // The block above is signed by hand after printing, which leaves the VAULT
      // copy a guardian downloads with a permanently blank line. This is the
      // digital half: a named approver, the date they signed, and a code whoever
      // is handed the card can check for themselves.
      //
      // Printed only when somebody has actually signed. A card with no head
      // remark carries no attestation, because a block asserting an approval
      // that did not happen is the exact failure this exists to prevent.
      if (d.attestation) {
        const a = d.attestation;
        const h = 46;
        const qr = 38;
        rect(L, y, W, h);
        drawQrCode(doc, a.verifyUrl, R - qr - 6, y + 4, qr);
        const tx = L + 6;
        const tw = W - qr - 20;
        doc.font("Helvetica-Bold").fontSize(6).fillColor("#333").text("VERIFIED SCHOOL RECORD", tx, y + 5, { width: tw });
        doc.font("Helvetica").fontSize(7.2).fillColor(INK).text(
          `Approved by ${a.approvedByName} (${a.approvedByRole}) on ${a.approvedAt.toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" })}.`,
          tx, y + 14, { width: tw },
        );
        doc.fontSize(6.2).fillColor("#555")
          .text(`Check this card at ${a.verifyUrl.replace(/^https?:\/\//, "")}`, tx, y + 25, { width: tw });
        // The version is printed because it is the one thing a holder cannot
        // otherwise know: a card reissued after a correction leaves earlier
        // printouts looking identical and no longer current.
        doc.font("Helvetica-Bold").fontSize(6.4).fillColor("#333")
          .text(`Code ${formatAttestationCode(a.code)}    Issue ${a.version}`, tx, y + 34, { width: tw });
        doc.fillColor(INK);
        y += h;
      }

      doc.font("Helvetica").fontSize(5.6).fillColor("#888").text(
        `Term weighting: ${d.components.map((c) => `${c.label} ${c.max}`).join(" · ")} = ${d.components.reduce((n, c) => n + c.max, 0)}.` +
          `    Generated ${new Date().toLocaleString()}.`,
        L, y + 3, { width: W },
      );
      doc.fillColor(INK);
  }

  /**
   * One PDF holding a card per pupil, in the order given.
   *
   * `renderPdf` is this with a single card, so the one-pupil path and the class
   * path can never render differently.
   */
  private renderPack(cards: ReportCardData[], logo?: Buffer | null): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const doc = createPdfDocument({ margin: 28, size: "A4" });
      const chunks: Buffer[] = [];
      doc.on("data", (c: Buffer) => chunks.push(c));
      doc.on("end", () => resolve(Buffer.concat(chunks)));
      doc.on("error", reject);
      cards.forEach((card, i) => {
        if (i > 0) doc.addPage();
        this.drawCard(doc, card, logo);
      });
      doc.end();
    });
  }

  private renderPdf(d: ReportCardData, logo?: Buffer | null): Promise<Buffer> {
    return this.renderPack([d], logo);
  }

  private async assertCanAccess(tx: TenantTx, p: Principal, studentId: string) {
    if (p.roles.some((r) => STAFF_WIDE.has(r))) return;
    if (p.userId === studentId) return;
    const link = await tx.parentChild.findFirst({ where: { parentId: p.userId, studentId }, select: { id: true } });
    if (link) return;
    const taught = await classIdsTaughtBy(tx, p.userId).then((ids: string[]) => ids.map((classId) => ({ classId })));
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
