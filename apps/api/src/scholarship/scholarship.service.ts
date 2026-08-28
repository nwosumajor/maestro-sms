// =============================================================================
// ScholarshipService — applicant side (parent/teacher), TENANT-scoped
// =============================================================================
// A parent (their children) or a teacher (students they teach) applies for a
// platform-sponsored scholarship on behalf of a student in THEIR school. Reads
// the GLOBAL program registry (RLS-exempt; the app role has SELECT) and writes a
// tenant-scoped `scholarship_application`. Submission requires GUARDIAN CONSENT
// (Golden Rule #5) and snapshots verified SIGNALS (grades/attendance/fees) for
// the platform reviewer — signals only, never a verdict (Golden Rule #8).
// Relationship scoping: applicant → students they may apply for; anyone else 404.
// =============================================================================

import { scholarshipSupervisorStage, WORKFLOW_PERMISSIONS } from "@sms/types";
import { BadRequestException, ConflictException, ForbiddenException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { reportedTermGrade, resolveGradeBands, type StoredTermResult, type ScholarshipPortalDto, type ScholarshipApplicationDto } from "@sms/types";
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
import { ON_ROLL_STUDENT } from "../common/student-scope";
import { toMinor } from "../common/money";
import { SchoolRegionService } from "../foundation/school-region.service";

const STAFF_WIDE = new Set(["school_admin", "principal"]);

@Injectable()
export class ScholarshipService {
  constructor(
    @Inject(TENANT_DATABASE) private readonly db: TenantDatabase,
    @Inject(AUDIT_LOG_SERVICE) private readonly audit: AuditLogService,
    private readonly notifications: NotificationService,
    private readonly region: SchoolRegionService,
  ) {}

  private ctx(p: Principal): TenantContext {
    return { schoolId: p.schoolId, userId: p.userId };
  }

  /** Student ids the caller may apply for: a STUDENT applies for THEMSELVES; a
   *  parent for their children; a teacher for students they teach. School-wide
   *  staff may apply for any student in the school. */
  private async applicableStudentIds(tx: TenantTx, p: Principal): Promise<Set<string>> {
    const ids = new Set<string>();
    if (p.roles.includes("student")) {
      ids.add(p.userId);
      return ids;
    }
    if (p.roles.some((r) => STAFF_WIDE.has(r))) {
      const students = await tx.user.findMany({
        // ON ROLL — a scholarship cannot be applied for on behalf of a pupil
        // who has already left the school.
        where: ON_ROLL_STUDENT,
        select: { id: true },
      });
      students.forEach((s: { id: string }) => ids.add(s.id));
      return ids;
    }
    const children = await tx.parentChild.findMany({ where: { parentId: p.userId }, select: { studentId: true } });
    children.forEach((c: { studentId: string }) => ids.add(c.studentId));
    const taught = await tx.classTeacher.findMany({ where: { teacherId: p.userId }, select: { classId: true } });
    const subjectTaught = await tx.classSubjectTeacher.findMany({ where: { teacherId: p.userId }, select: { classId: true } });
    const classIds = [...new Set([...taught, ...subjectTaught].map((t: { classId: string }) => t.classId))];
    if (classIds.length) {
      const enrolled = await tx.enrollment.findMany({
        where: { classId: { in: classIds }, status: "ACTIVE" },
        select: { studentId: true },
      });
      enrolled.forEach((e: { studentId: string }) => ids.add(e.studentId));
    }
    return ids;
  }

  private async openPrograms(tx: TenantTx) {
    const now = new Date();
    const rows = await tx.scholarshipProgram.findMany({
      where: { status: "OPEN", opensAt: { lte: now }, closesAt: { gte: now } },
      orderBy: { closesAt: "asc" },
    });
    return rows;
  }

  // ---------------------------------------------------------------------------
  // Applicant portal: open programs + students I can apply for + my applications
  // ---------------------------------------------------------------------------
  async getPortal(p: Principal): Promise<ScholarshipPortalDto> {
    return this.db.runAsTenant(this.ctx(p), async (tx) => {
      const [programs, applicable] = await Promise.all([this.openPrograms(tx), this.applicableStudentIds(tx, p)]);
      const studentIds = [...applicable];
      const students = studentIds.length
        ? await tx.user.findMany({ where: { id: { in: studentIds } }, select: { id: true, name: true }, orderBy: { name: "asc" } })
        : [];
      const apps = await tx.scholarshipApplication.findMany({
        where: { applicantId: p.userId },
        orderBy: { createdAt: "desc" },
      });
      const applications = await this.toApplicationDtos(tx, apps);
      const pendingDecisions = await this.toApplicationDtos(tx, await this.pendingForMe(tx, p));
      return {
        programs: programs.map((pr) => this.programDto(pr)),
        students: students.map((s: { id: string; name: string }) => ({ id: s.id, name: s.name })),
        applications,
        pendingDecisions,
      };
    });
  }

  /** School leadership's oversight list: every application raised in THEIR OWN
   *  school, newest first.
   *
   *  `scholarship.read` was an orphaned permission — held by board, principal,
   *  school_admin and super_admin, and gating nothing. It put "Scholarships" in
   *  the nav and a "Requests & decisions" tile on the dashboard, and the page
   *  told leadership they could "see your students' applications and outcomes
   *  here" while fetching nothing for them. board and school_admin (who hold
   *  READ but not APPLY) reached a permanent dead end.
   *
   *  DRAFTs are excluded deliberately: a draft is a half-written form belonging
   *  to the parent or teacher composing it, and oversight begins when it is
   *  submitted. This mirrors the platform owner's own review queue, which lists
   *  non-DRAFT only — leadership should not see MORE than the sponsor does.
   *
   *  Scoping is the tenant boundary itself: runAsTenant sets the GUC and RLS
   *  confines the rows to the caller's school, so there is no second scoping
   *  rule here to drift out of step with the first. */
  async listForSchool(p: Principal): Promise<ScholarshipApplicationDto[]> {
    return this.db.runAsTenantReadOnly(this.ctx(p), async (tx) => {
      const rows = await tx.scholarshipApplication.findMany({
        where: { status: { not: "DRAFT" } },
        orderBy: { createdAt: "desc" },
        take: 500,
      });
      return this.toApplicationDtos(tx, rows);
    });
  }

  /** Applications sitting at MY chain stage: class supervisor → their classes'
   *  students; guardian → their children; principal (by permission,
   *  see decideStage) → school-wide. */
  private async pendingForMe(tx: TenantTx, p: Principal) {
    const out: Array<Awaited<ReturnType<TenantTx["scholarshipApplication"]["findMany"]>>[number]> = [];
    const supervised = await tx.classTeacher.findMany({ where: { teacherId: p.userId }, select: { classId: true } });
    if (supervised.length) {
      const enrolled = await tx.enrollment.findMany({
        where: { classId: { in: supervised.map((c: { classId: string }) => c.classId) }, status: "ACTIVE" },
        select: { studentId: true },
      });
      const studentIds = [...new Set(enrolled.map((e: { studentId: string }) => e.studentId))];
      if (studentIds.length) {
        out.push(
          ...(await tx.scholarshipApplication.findMany({
            where: { status: "PENDING_SUPERVISOR", studentId: { in: studentIds } },
            orderBy: { createdAt: "asc" },
          })),
        );
      }
    }
    const children = await tx.parentChild.findMany({ where: { parentId: p.userId }, select: { studentId: true } });
    if (children.length) {
      out.push(
        ...(await tx.scholarshipApplication.findMany({
          where: { status: "PENDING_PARENT", studentId: { in: children.map((c: { studentId: string }) => c.studentId) } },
          orderBy: { createdAt: "asc" },
        })),
      );
    }
    // Same permission the decision gate uses, deliberately: a queue keyed on the
    // role while the gate is keyed on the permission gives a delegate the power
    // to decide and nothing to decide on.
    if (p.permissions.includes(WORKFLOW_PERMISSIONS.REVIEW_PRINCIPAL)) {
      out.push(...(await tx.scholarshipApplication.findMany({ where: { status: "PENDING_PRINCIPAL" }, orderBy: { createdAt: "asc" } })));
    }
    return out;
  }

  // ---------------------------------------------------------------------------
  // Apply (DRAFT) — relationship-scoped to the student
  // ---------------------------------------------------------------------------
  async apply(p: Principal, input: { programId: string; studentId: string; answers?: unknown }): Promise<ScholarshipApplicationDto> {
    return this.db.runAsTenant(this.ctx(p), async (tx) => {
      const program = await tx.scholarshipProgram.findFirst({ where: { id: input.programId } });
      if (!program) throw new NotFoundException("Program not found");
      const now = new Date();
      if (program.status !== "OPEN" || program.opensAt > now || program.closesAt < now) {
        throw new BadRequestException("This scholarship is not open for applications");
      }
      const applicable = await this.applicableStudentIds(tx, p);
      if (!applicable.has(input.studentId)) throw new NotFoundException("Student not found"); // 404 not 403
      const existing = await tx.scholarshipApplication.findFirst({
        where: { programId: input.programId, studentId: input.studentId },
        select: { id: true },
      });
      if (existing) throw new ConflictException("An application for this student already exists for this scholarship");

      const applicantRole = p.roles.includes("student")
        ? "student"
        : p.roles.includes("parent") ? "parent" : p.roles.includes("teacher") ? "teacher" : p.roles[0] ?? "staff";
      const row = await tx.scholarshipApplication.create({
        data: {
          schoolId: p.schoolId,
          programId: input.programId,
          studentId: input.studentId,
          applicantId: p.userId,
          applicantRole,
          answers: (input.answers ?? null) as never,
          status: "DRAFT",
        },
      });
      await this.log(tx, p, "scholarship.apply", row.id, { programId: input.programId, studentId: input.studentId });
      return (await this.toApplicationDtos(tx, [row]))[0];
    });
  }

  /** Update DRAFT answers (owner only, DRAFT only). */
  async updateAnswers(p: Principal, id: string, answers: unknown): Promise<ScholarshipApplicationDto> {
    return this.db.runAsTenant(this.ctx(p), async (tx) => {
      const app = await this.ownDraft(tx, p, id);
      const row = await tx.scholarshipApplication.update({ where: { id: app.id }, data: { answers: (answers ?? null) as never } });
      return (await this.toApplicationDtos(tx, [row]))[0];
    });
  }

  // ---------------------------------------------------------------------------
  // Guardian consent — REQUIRED before submission (Golden Rule #5)
  // ---------------------------------------------------------------------------
  /** Record a guardian's consent to disclose the minor's data to the platform.
   *  ONLY a parent linked to the student may consent (the applicant, if a parent,
   *  or a different guardian when a teacher applied). */
  async consent(p: Principal, id: string): Promise<ScholarshipApplicationDto> {
    return this.db.runAsTenant(this.ctx(p), async (tx) => {
      const app = await tx.scholarshipApplication.findFirst({ where: { id } });
      if (!app) throw new NotFoundException("Application not found");
      const guardian = await tx.parentChild.findFirst({ where: { parentId: p.userId, studentId: app.studentId }, select: { id: true } });
      if (!guardian) throw new ForbiddenException("Only a guardian of this student can give consent");
      const row = await tx.scholarshipApplication.update({
        where: { id },
        data: { consentById: p.userId, consentAt: new Date() },
      });
      await this.log(tx, p, "scholarship.consent", id, { studentId: app.studentId });
      return (await this.toApplicationDtos(tx, [row]))[0];
    });
  }

  // ---------------------------------------------------------------------------
  // Submit — snapshot signals, then route by who applied:
  //   student  → PENDING_SUPERVISOR (the approval chain: class supervisor →
  //              guardian [whose approval IS the consent] → principal → platform)
  //   others   → SUBMITTED directly (legacy parent/teacher path; consent required
  //              up-front as before)
  // ---------------------------------------------------------------------------
  async submit(p: Principal, id: string): Promise<ScholarshipApplicationDto> {
    const result = await this.db.runAsTenant(this.ctx(p), async (tx) => {
      const app = await this.ownDraft(tx, p, id);
      const isStudentChain = app.applicantRole === "student";
      if (isStudentChain) {
        // The detailed request form is mandatory for a student's own request.
        const form = (app.answers ?? {}) as { reason?: string };
        if (!form.reason || !String(form.reason).trim()) {
          throw new BadRequestException("Please state the reason for your scholarship request before submitting");
        }
      } else if (!app.consentAt) {
        throw new BadRequestException("A guardian must give consent before this application can be submitted");
      }
      const signals = await this.collectSignals(tx, app.studentId, p.schoolId);
      // FAIL OPEN WHEN THERE IS NO SUPERVISOR TO ASK.
      //
      // Stage 1 can only be decided by a class teacher of a class the pupil is
      // actively enrolled in. A class with no teacher — 30 of 31 in the demo
      // database, covering 899 pupils — left the request decidable by NOBODY:
      // not the principal, who has no override here, and not the platform owner,
      // whose queue refuses anything that has not completed school approval.
      // Verified against each of them before this changed.
      //
      // A subject selection already solves this by going straight to the next
      // stage, and this follows it — including the part that matters, that the
      // skip is VISIBLE (scholarshipSupervisorStage) rather than a PENDING_PARENT
      // indistinguishable from one a teacher passed.
      const hasSupervisor = isStudentChain ? await this.hasClassSupervisor(tx, app.studentId) : false;
      const nextStatus = !isStudentChain ? "SUBMITTED" : hasSupervisor ? "PENDING_SUPERVISOR" : "PENDING_PARENT";
      const row = await tx.scholarshipApplication.update({
        where: { id: app.id },
        data: { status: nextStatus, signals: signals as never },
      });
      await this.log(tx, p, "scholarship.submit", app.id, { studentId: app.studentId, chain: isStudentChain });
      return { row, studentId: app.studentId, isStudentChain, hasSupervisor };
    });
    // Best-effort notifications: chain → wake the class supervisor(s); legacy →
    // tell the guardians it's in.
    try {
      const dto = await this.db.runAsTenant(this.ctx(p), (tx) => this.toApplicationDtos(tx, [result.row]));
      if (result.isStudentChain && !result.hasSupervisor) {
        // Stage 1 was skipped, so the guardian is who must act — telling
        // supervisors who do not exist is what left these requests silent.
        await this.notifyGuardians(
          p,
          result.studentId,
          `Scholarship request for ${dto[0].studentName} needs your consent`,
          "Their class has no supervisor recorded, so it comes to you next. Open Scholarships to approve or reject it.",
        );
      } else if (result.isStudentChain) {
        await this.notifySupervisors(
          p,
          result.studentId,
          `Scholarship request from ${dto[0].studentName} awaits your approval`,
          "Open Scholarships → Awaiting your decision to approve or reject it.",
        );
        await this.notifyUser(p, result.studentId, "Your scholarship request is with your class supervisor", `“${dto[0].programTitle}” — you'll be notified at every stage.`);
      } else {
        await this.notifyGuardians(p, result.studentId, `Scholarship application submitted for ${dto[0].studentName}`);
      }
      return dto[0];
    } catch {
      return this.db.runAsTenant(this.ctx(p), (tx) => this.toApplicationDtos(tx, [result.row])).then((d) => d[0]);
    }
  }

  // ---------------------------------------------------------------------------
  // The approval chain — one endpoint, routed by the application's stage.
  // SECURITY: each stage is decided by exactly the RIGHT person, verified by
  // RELATIONSHIP (not just role): the class supervisor must teach a class the
  // student is actively enrolled in; the parent must be a linked guardian (their
  // approval doubles as the Golden-Rule-#5 consent); the principal must hold the
  // principal role in the school. Everyone else gets 404 — cross-scope existence
  // never leaks. Every decision is audited and everyone affected is notified.
  // ---------------------------------------------------------------------------
  async decideStage(
    p: Principal,
    id: string,
    body: { decision: "APPROVE" | "REJECT"; note?: string },
  ): Promise<ScholarshipApplicationDto> {
    const note = body.note?.trim() || null;
    const outcome = await this.db.runAsTenant(this.ctx(p), async (tx) => {
      const app = await tx.scholarshipApplication.findFirst({ where: { id } });
      if (!app) throw new NotFoundException("Application not found");
      const approve = body.decision === "APPROVE";
      const now = new Date();

      let stage: "SUPERVISOR" | "PARENT" | "PRINCIPAL";
      let data: Record<string, unknown>;
      if (app.status === "PENDING_SUPERVISOR") {
        stage = "SUPERVISOR";
        const classIds = (
          await tx.enrollment.findMany({ where: { studentId: app.studentId, status: "ACTIVE" }, select: { classId: true } })
        ).map((e: { classId: string }) => e.classId);
        const supervises = classIds.length
          ? await tx.classTeacher.findFirst({ where: { teacherId: p.userId, classId: { in: classIds } }, select: { id: true } })
          : null;
        if (!supervises) throw new NotFoundException("Application not found"); // 404 not 403
        data = {
          supervisorById: p.userId,
          supervisorAt: now,
          supervisorNote: note,
          status: approve ? "PENDING_PARENT" : "REJECTED",
          ...(approve ? {} : { rejectedStage: "SUPERVISOR" }),
        };
      } else if (app.status === "PENDING_PARENT") {
        stage = "PARENT";
        const guardian = await tx.parentChild.findFirst({ where: { parentId: p.userId, studentId: app.studentId }, select: { id: true } });
        if (!guardian) throw new NotFoundException("Application not found");
        data = {
          // Guardian approval IS the consent to disclose the minor's data to the
          // platform (Golden Rule #5) — one act, recorded as both.
          consentById: p.userId,
          consentAt: now,
          parentNote: note,
          status: approve ? "PENDING_PRINCIPAL" : "REJECTED",
          ...(approve ? {} : { rejectedStage: "PARENT", consentById: null, consentAt: null }),
        };
      } else if (app.status === "PENDING_PRINCIPAL") {
        stage = "PRINCIPAL";
        // The PERMISSION, not the role name.
        //
        // Only `principal` holds workflow.review.principal today, so this changes
        // nothing for any existing school — but it is the difference between a
        // chain a school can unstick and one it cannot. Checked by role name, a
        // school whose principal account is deactivated (a staff exit revokes
        // access) has every pending request stranded at this stage with NO way
        // forward: there is no override here, and unlike the supervisor stage
        // there is no next reviewer to fail open to — skipping it would send an
        // application to the platform without the school's endorsement, which is
        // the control itself.
        //
        // Checked by permission, the school grants it to another leader and the
        // queue moves. It is also how the workflow engine expresses the same
        // stage (STAFF_REQUEST_CHAIN's principal step), so the two now agree.
        if (!p.permissions.includes(WORKFLOW_PERMISSIONS.REVIEW_PRINCIPAL)) {
          throw new NotFoundException("Application not found");
        }
        data = {
          principalById: p.userId,
          principalAt: now,
          principalNote: note,
          status: approve ? "SUBMITTED" : "REJECTED",
          ...(approve ? {} : { rejectedStage: "PRINCIPAL" }),
        };
      } else {
        throw new ConflictException("This application is not awaiting a decision at your stage");
      }

      const row = await tx.scholarshipApplication.update({ where: { id }, data: data as never });
      await this.log(tx, p, `scholarship.stage.${stage.toLowerCase()}.${approve ? "approve" : "reject"}`, id, {
        studentId: app.studentId,
        stage,
      });
      return { row, stage, approve, studentId: app.studentId };
    });

    // Best-effort stage notifications to everyone who should hear about it.
    const dto = await this.db.runAsTenant(this.ctx(p), (tx) => this.toApplicationDtos(tx, [outcome.row]));
    const title = dto[0].programTitle;
    const student = dto[0].studentName;
    try {
      if (!outcome.approve) {
        const stageName = outcome.stage === "SUPERVISOR" ? "class supervisor" : outcome.stage === "PARENT" ? "guardian" : "principal";
        await this.notifyUser(p, outcome.studentId, `Your scholarship request was not approved`, `“${title}” was declined at the ${stageName} stage.${note ? ` Note: ${note}` : ""}`);
        await this.notifyGuardians(p, outcome.studentId, `${student}'s scholarship request was declined at the ${stageName} stage`);
      } else if (outcome.stage === "SUPERVISOR") {
        await this.notifyUser(p, outcome.studentId, "Class supervisor approved your scholarship request", `“${title}” now awaits your parent/guardian's approval.`);
        await this.notifyGuardians(p, outcome.studentId, `${student}'s scholarship request needs YOUR approval`, "Your approval also gives consent to share their academic record with the scholarship sponsor. Open Scholarships to decide.");
      } else if (outcome.stage === "PARENT") {
        await this.notifyUser(p, outcome.studentId, "Your guardian approved your scholarship request", `“${title}” now awaits the principal's approval.`);
        await this.notifyPrincipals(p, `Scholarship request from ${student} awaits your approval`, "Open Scholarships → Awaiting your decision.");
      } else {
        await this.notifyUser(p, outcome.studentId, "The principal approved your scholarship request", `“${title}” has been forwarded to the scholarship sponsor for final review.`);
        await this.notifyGuardians(p, outcome.studentId, `${student}'s scholarship request was forwarded to the sponsor`, "The platform team will review it and you'll both be notified of the outcome.");
      }
    } catch {
      // notifications are best-effort; the decision itself is committed
    }
    return dto[0];
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------
  private async ownDraft(tx: TenantTx, p: Principal, id: string) {
    const app = await tx.scholarshipApplication.findFirst({ where: { id } });
    if (!app) throw new NotFoundException("Application not found");
    if (app.applicantId !== p.userId && !p.roles.some((r) => STAFF_WIDE.has(r))) {
      throw new NotFoundException("Application not found");
    }
    if (app.status !== "DRAFT") throw new ConflictException("This application can no longer be edited");
    return app;
  }

  /** Verified merit/need signals for the reviewer (Golden Rule #8: signals only). */
  private async collectSignals(tx: TenantTx, studentId: string, schoolId: string) {
    // The applicant's own school's weighting. A merit signal computed on the
    // platform's weights would not match the average on the pupil's own report
    // card — and this figure is read by a reviewer deciding an award.
    const grading = (await this.region.academicInTx(tx, schoolId)).grading;
    const published = await tx.subjectResult.findMany({
      where: { studentId, status: "PUBLISHED" },
      // The figures each result was PUBLISHED with. A merit signal recomputed on
      // today's weighting would not match the report card the family holds — and
      // this number is read by a reviewer deciding whether to fund a child.
      select: {
        exam: true, midterm: true, assignment: true, classNote: true,
        status: true, total: true, grade: true,
      },
    });
    const totals = published
      .map((r: StoredTermResult) => {
        const any = [r.exam, r.midterm, r.assignment, r.classNote].some((v) => v !== null);
        return any ? reportedTermGrade(r, grading.components, resolveGradeBands(grading)).total : null;
      })
      .filter((v): v is number => v !== null);
    const publishedSessionAverage = totals.length ? Math.round((totals.reduce((s, v) => s + v, 0) / totals.length) * 100) / 100 : null;

    // EXCUSED COUNTS AS ATTENDING, which is this platform's rule and was not
    // this signal's. AttendanceRollupService states it where the figure is
    // defined: "LATE and EXCUSED count as attending — the pupil was in school,
    // or their absence was authorised. Counting them against attendance would
    // understate it and contradict the report card, which uses the same rule."
    // The group console, the LMS engagement figure and the parent portal all
    // follow it; this one put EXCUSED in the denominator only.
    //
    // It is read by somebody deciding whether to fund a child, so the effect was
    // to hold an authorised absence — illness with a note, a bereavement, a
    // hospital appointment — against them, and to disagree with the attendance
    // percentage printed on their own report card.
    const att = await tx.attendanceRecord.groupBy({ by: ["status"], where: { studentId }, _count: { _all: true } });
    const count = (s: string) => att.find((a: { status: string; _count: { _all: number } }) => a.status === s)?._count._all ?? 0;
    const attended = count("PRESENT") + count("LATE") + count("EXCUSED");
    const attTotal = attended + count("ABSENT");
    const attendanceRatePct = attTotal ? Math.round((attended / attTotal) * 100) : null;

    const invoices = await tx.invoice.findMany({
      where: { studentId, status: { in: ["ISSUED", "PARTIALLY_PAID"] } },
      include: { payments: true },
    });
    const outstandingFeesMinor = invoices.reduce((sum: number, inv: { totalMinor: number; payments: { kind: string; amountMinor: number; status: string }[] }) => {
      const paid = inv.payments
        .filter((pay) => pay.status === "POSTED")
        .reduce((s, pay) => s + (pay.kind === "REFUND" ? -pay.amountMinor : pay.amountMinor), 0);
      return sum + Math.max(0, inv.totalMinor - paid);
    }, 0);

    // The student's class(es), discipline record and completed tasks — the
    // profile context the reviewer chain asked for. Counts/names only.
    const enrolments = await tx.enrollment.findMany({
      where: { studentId, status: "ACTIVE" },
      select: { class: { select: { name: true } } },
    });
    const classNames = enrolments.map((e: { class: { name: string } }) => e.class.name);
    // UPHELD and OPEN, counted apart — never one number.
    //
    // This was a single `count()` over every complaint ever filed against the
    // pupil, at any status. `discipline.file` is held by STUDENTS, so a
    // classmate's accusation counted; so did one the school investigated and
    // DISMISSED. That number sat beside the grade average in front of the
    // person deciding an award, and nothing on the screen said which of the
    // four statuses it contained.
    //
    // DISMISSED is excluded entirely rather than reported as a third figure: the
    // school has already found it baseless, and a reviewer cannot unsee a
    // number once it is on the page.
    const [disciplineUpheld, disciplineOpen] = await Promise.all([
      tx.disciplineComplaint.count({ where: { againstId: studentId, status: "RESOLVED" } }),
      tx.disciplineComplaint.count({ where: { againstId: studentId, status: { in: ["OPEN", "IN_REVIEW"] } } }),
    ]);
    const tasksCompleted = await tx.taskAssignment.count({ where: { assigneeId: studentId, status: "DONE" } });

    return {
      publishedSessionAverage,
      attendanceRatePct,
      outstandingFeesMinor,
      classNames,
      disciplineUpheld,
      disciplineOpen,
      tasksCompleted,
      capturedAt: new Date(),
    };
  }

  private programDto(pr: {
    id: string; title: string; description: string | null; budgetMinor: bigint | number; awardMinor: number;
    award2Minor: number | null; award3Minor: number | null;
    awardKind: string; selectionBasis: string; eligibility: unknown; opensAt: Date; closesAt: Date; status: string;
    category: string; examMode: string | null; examAt: Date | null; examVenue: string | null;
    examDurationMin: number; examQuestions: unknown; createdAt: Date;
  }) {
    return {
      id: pr.id, title: pr.title, description: pr.description, budgetMinor: toMinor(pr.budgetMinor),
      // A family's view does not need the committed spend, and it is not theirs
      // to know — the operator's console computes it.
      committedMinor: 0, awardMinor: pr.awardMinor,
      award2Minor: pr.award2Minor, award3Minor: pr.award3Minor,
      awardKind: pr.awardKind, selectionBasis: pr.selectionBasis, eligibility: pr.eligibility ?? null,
      opensAt: pr.opensAt, closesAt: pr.closesAt, status: pr.status,
      category: pr.category, examMode: pr.examMode, examAt: pr.examAt, examVenue: pr.examVenue,
      examDurationMin: pr.examDurationMin,
      // SECURITY: the count only — the question set (with answers) never leaves
      // the platform-owned row toward applicants.
      examQuestionCount: Array.isArray(pr.examQuestions) ? pr.examQuestions.length : 0,
      createdAt: pr.createdAt,
    };
  }

  /** Map application rows to DTOs, resolving program titles, student + applicant
   *  names. `schoolName` stays null here (only the operator cross-tenant view sets it). */
  private async toApplicationDtos(
    tx: TenantTx,
    rows: Array<{
      id: string; programId: string; schoolId: string; studentId: string; applicantId: string; applicantRole: string;
      answers: unknown; signals: unknown; status: string; consentById: string | null; consentAt: Date | null;
      supervisorById: string | null; supervisorAt: Date | null; supervisorNote: string | null;
      parentNote: string | null; principalById: string | null; principalAt: Date | null; principalNote: string | null;
      rejectedStage: string | null; examScorePct: number | null; awardPosition: number | null;
      awardMinor: number | null; reviewNote: string | null; createdAt: Date; updatedAt: Date;
      disbursementPaymentId?: string | null;
    }>,
  ): Promise<ScholarshipApplicationDto[]> {
    if (rows.length === 0) return [];
    const programIds = [...new Set(rows.map((r) => r.programId))];
    const userIds = [...new Set(rows.flatMap((r) => [r.studentId, r.applicantId]))];
    const [programs, users] = await Promise.all([
      tx.scholarshipProgram.findMany({
        where: { id: { in: programIds } },
        select: { id: true, title: true, awardMinor: true, examMode: true, examAt: true },
      }),
      tx.user.findMany({ where: { id: { in: userIds } }, select: { id: true, name: true } }),
    ]);
    const prog = new Map(
      programs.map((pr: { id: string; title: string; awardMinor: number; examMode: string | null; examAt: Date | null }) => [pr.id, pr]),
    );
    const name = new Map(users.map((u: { id: string; name: string }) => [u.id, u.name]));
    return rows.map((r) => ({
      id: r.id,
      programId: r.programId,
      programTitle: prog.get(r.programId)?.title ?? "Scholarship",
      awardMinorOffered: prog.get(r.programId)?.awardMinor ?? 0,
      // Granted is not the same as CREDITED. Null unless the award was made, so
      // "not awarded" and "awarded but not yet credited" stay distinguishable —
      // the ambiguity the export bundle's coverage manifest exists to remove,
      // applied to money.
      disbursed: r.status === "AWARDED" ? Boolean(r.disbursementPaymentId) : null,
      schoolId: r.schoolId,
      schoolName: null,
      studentId: r.studentId,
      studentName: name.get(r.studentId) ?? "Student",
      applicantId: r.applicantId,
      applicantName: name.get(r.applicantId) ?? "Applicant",
      applicantRole: r.applicantRole,
      answers: r.answers ?? null,
      signals: (r.signals as ScholarshipApplicationDto["signals"]) ?? null,
      status: r.status,
      consentById: r.consentById,
      consentAt: r.consentAt,
      supervisorById: r.supervisorById,
      supervisorStage: scholarshipSupervisorStage(r),
      supervisorAt: r.supervisorAt,
      supervisorNote: r.supervisorNote,
      parentNote: r.parentNote,
      principalById: r.principalById,
      principalAt: r.principalAt,
      principalNote: r.principalNote,
      rejectedStage: r.rejectedStage,
      examMode: prog.get(r.programId)?.examMode ?? null,
      examAt: prog.get(r.programId)?.examAt ?? null,
      examScorePct: r.examScorePct,
      awardPosition: r.awardPosition,
      awardMinor: r.awardMinor,
      reviewNote: r.reviewNote,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
    }));
  }

  private async notifyGuardians(p: Principal, studentId: string, title: string, body?: string) {
    const guardians = await this.db.runAsTenant(this.ctx(p), (tx) =>
      tx.parentChild.findMany({ where: { studentId }, select: { parentId: true } }),
    );
    for (const g of guardians as Array<{ parentId: string }>) {
      await this.notifications.enqueue(this.ctx(p), {
        recipientId: g.parentId,
        type: "SCHOLARSHIP",
        title,
        body: body ?? "You can track its status in the Scholarships section.",
      }).catch(() => undefined);
    }
  }

  private async notifyUser(p: Principal, userId: string, title: string, body: string) {
    await this.notifications
      .enqueue(this.ctx(p), { recipientId: userId, type: "SCHOLARSHIP", title, body })
      .catch(() => undefined);
  }

  /** The class supervisor(s): assigned class teachers of the student's ACTIVE classes. */
  /**
   * Is there anybody who could decide stage 1 for this pupil?
   *
   * The same question `decideStage` asks when it authorises a supervisor, asked
   * BEFORE the request is parked in a state only they can leave. One query.
   */
  private async hasClassSupervisor(tx: TenantTx, studentId: string): Promise<boolean> {
    const classIds = (
      (await tx.enrollment.findMany({
        where: { studentId, status: "ACTIVE" },
        select: { classId: true },
      })) as Array<{ classId: string }>
    ).map((e) => e.classId);
    if (classIds.length === 0) return false; // no class at all — nobody supervises them
    const one = await tx.classTeacher.findFirst({ where: { classId: { in: classIds } }, select: { id: true } });
    return !!one;
  }

  private async notifySupervisors(p: Principal, studentId: string, title: string, body: string) {
    const teacherIds = await this.db.runAsTenant(this.ctx(p), async (tx) => {
      const classIds = (
        await tx.enrollment.findMany({ where: { studentId, status: "ACTIVE" }, select: { classId: true } })
      ).map((e: { classId: string }) => e.classId);
      if (!classIds.length) return [] as string[];
      const teachers = await tx.classTeacher.findMany({ where: { classId: { in: classIds } }, select: { teacherId: true } });
      return [...new Set(teachers.map((t: { teacherId: string }) => t.teacherId))];
    });
    for (const id of teacherIds) await this.notifyUser(p, id, title, body);
  }

  private async notifyPrincipals(p: Principal, title: string, body: string) {
    const principalIds = await this.db.runAsTenant(this.ctx(p), async (tx) => {
      const rows = await tx.userRole.findMany({ where: { role: { name: "principal" } }, select: { userId: true } });
      return [...new Set(rows.map((r: { userId: string }) => r.userId))];
    });
    for (const id of principalIds) await this.notifyUser(p, id, title, body);
  }

  private async log(tx: TenantTx, p: Principal, action: string, entityId: string, metadata?: Record<string, unknown>) {
    await this.audit.record(
      { actorId: p.userId, action, entity: "scholarship_application", entityId, schoolId: p.schoolId, metadata },
      tx,
    );
  }
}
