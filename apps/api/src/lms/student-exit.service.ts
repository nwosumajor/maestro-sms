// =============================================================================
// StudentExitService — a pupil leaves the school
// =============================================================================
// WHAT THIS REPLACES. Leaving was a single button on the class roster: one
// click, one permission, no second person. It flipped ONE enrolment row to
// WITHDRAWN and nothing else — so the pupil's account stayed ACTIVE, they could
// still sign in, and every class they were in other than that one still listed
// them. There was no concept of leaving the SCHOOL at all, only of leaving a
// class, which is why nothing ever revoked access.
//
// TWO DIFFERENT FACTS, now modelled separately:
//   Enrolment.status  — "is this pupil in this class"
//   User.status       — "may this person use the platform at all"
// Only the second ends access, and only the workflow below may set it.
//
// TWO STAGES, and the second is the principal alone. Ending a child's access
// and closing every enrolment at once is not a roster edit. The engine
// guarantees the two approvers are different people; the permission split
// (school_admin/head_teacher raise, principal approves) means they cannot even
// be the same role.
//
// NOTHING IS DELETED. Report cards, invoices, documents and the NDPR export all
// survive an exit and stay readable by staff — a school still owes a leaver
// their records, and a departure that destroyed them would be the more serious
// failure. What ends is authentication.
// =============================================================================

import { BadRequestException, ForbiddenException, Inject, Injectable, NotFoundException, ServiceUnavailableException } from "@nestjs/common";
import { STUDENT_EXIT_CHAIN, formatMoney } from "@sms/types";
import {
  AUDIT_LOG_SERVICE,
  TENANT_DATABASE,
  type AuditLogService,
  type Principal,
  type TenantContext,
  type TenantDatabase,
  type TenantTx,
} from "../integrity/integrity.foundation";
import { WorkflowService } from "../workflow/workflow.service";
import { WorkflowHooksService } from "../workflow/workflow-hooks.service";
import { PrivilegedDatabaseService } from "../common/privileged-database.service";

export type ExitKind = "WITHDRAWN" | "TRANSFERRED" | "GRADUATED";

/** Who may see exit information at all — whole-school staff. Mirrors the
 *  ROSTER_WIDE set used elsewhere; a class teacher is deliberately not here. */
const EXIT_VIEW_ROLES = new Set(["principal", "school_admin", "head_teacher", "junior_admin"]);

export interface StudentExitPreviewDto {
  studentId: string;
  studentName: string;
  classNames: string[];
  /** Money still owed. A SIGNAL for the approver, never a block — a school that
   *  cannot release a leaver because of a debt has an NDPR problem, not a
   *  collections one. */
  outstandingMinor: number;
  currency: string;
  alreadyExited: boolean;
}

@Injectable()
export class StudentExitService {
  constructor(
    @Inject(TENANT_DATABASE) private readonly db: TenantDatabase,
    @Inject(AUDIT_LOG_SERVICE) private readonly audit: AuditLogService,
    private readonly workflow: WorkflowService,
    private readonly privileged: PrivilegedDatabaseService,
    hooks: WorkflowHooksService,
  ) {
    // The reactor runs IN the transition's own transaction, so the exit is
    // atomic with the approval: a pupil can never end up half-exited, with
    // access revoked but enrolments open or the reverse.
    hooks.onFinalized(async (tx, req) => {
      if (req.type !== "STUDENT_EXIT" || req.state !== "APPROVED") return;
      const pl = req.payload as { studentId?: string; kind?: ExitKind; reason?: string } | null;
      if (!pl?.studentId) return;
      await this.applyExit(tx, req.schoolId, req.initiatorId, pl.studentId, pl.kind ?? "WITHDRAWN", pl.reason);
    });
  }

  private ctx(p: Principal): TenantContext {
    return { schoolId: p.schoolId, userId: p.userId };
  }

  /**
   * Set how long this school keeps a leaver's record before prompting review.
   *
   * A POLICY setting on the global registry, so it goes through the privileged
   * client like every other `school` write — the app role is SELECT-only there.
   */
  async setRetentionYears(p: Principal, years: number): Promise<{ leaverRetentionYears: number }> {
    this.assertWholeSchool(p);
    if (!Number.isInteger(years) || years < 0 || years > 50) {
      throw new BadRequestException("Retention must be a whole number of years between 0 and 50");
    }
    const client = this.privileged.client;
    if (!client) throw new ServiceUnavailableException("Registry writes are not configured");
    await client.school.update({ where: { id: p.schoolId }, data: { leaverRetentionYears: years } });
    await this.db.runAsTenant(this.ctx(p), (tx) =>
      this.audit.record(
        {
          actorId: p.userId,
          action: "student.exit.retention.set",
          entity: "school",
          entityId: p.schoolId,
          schoolId: p.schoolId,
          metadata: { years },
        },
        tx,
      ),
    );
    return { leaverRetentionYears: years };
  }

  /**
   * ROW SCOPE for the two read paths.
   *
   * The routes are gated on `student.profile.read`, which a class teacher also
   * holds — the coarse permission has to be wide enough to include the
   * PRINCIPAL, who deliberately does not hold the raise permission. So the rows
   * are narrowed here, the way every other module in this codebase does it:
   * permission gates the endpoint, the role set narrows what comes back.
   */
  private assertWholeSchool(p: Principal): void {
    if (!p.roles.some((r) => EXIT_VIEW_ROLES.has(r))) {
      // 404, not 403 — the same posture as every other out-of-scope read here.
      throw new NotFoundException("Not found");
    }
  }

  /** What the approver should see before authorising. */
  async preview(p: Principal, studentId: string): Promise<StudentExitPreviewDto> {
    this.assertWholeSchool(p);
    return this.db.runAsTenant(this.ctx(p), async (tx) => {
      const student = await tx.user.findFirst({
        where: { id: studentId },
        select: { id: true, name: true, status: true },
      });
      if (!student) throw new NotFoundException("Student not found");

      const enrolments = await tx.enrollment.findMany({
        where: { studentId, status: "ACTIVE" },
        select: { class: { select: { name: true } } },
      });
      // One aggregate, never a row-by-row hydrate: an invoice list grows with
      // the pupil's whole time at the school and nothing here needs the rows.
      const owed = await tx.invoice.aggregate({
        // Billable states only — DRAFT is not owed yet and CANCELLED never was.
        where: { studentId, status: { in: ["ISSUED", "PARTIALLY_PAID"] } },
        _sum: { totalMinor: true },
      });
      const paid = await tx.payment.aggregate({
        where: { invoice: { studentId }, status: "POSTED", kind: "PAYMENT" },
        _sum: { amountMinor: true },
      });
      const school = await tx.school.findFirst({ where: { id: p.schoolId }, select: { currency: true } });

      return {
        studentId,
        studentName: student.name,
        classNames: (enrolments as Array<{ class: { name: string } | null }>).map((e) => e.class?.name ?? "—"),
        outstandingMinor: Math.max(0, (owed._sum?.totalMinor ?? 0) - (paid._sum?.amountMinor ?? 0)),
        currency: school?.currency ?? "NGN",
        alreadyExited: student.status === "EXITED",
      };
    });
  }

  /** Raise the exit. Stage 1 signs it by raising it; the principal authorises. */
  async request(
    p: Principal,
    studentId: string,
    kind: ExitKind,
    reason?: string,
  ): Promise<{ pendingApproval: true; requestId: string }> {
    const preview = await this.preview(p, studentId);
    if (preview.alreadyExited) throw new ForbiddenException("This student has already left");

    // SNAPSHOT THE FACTS THE APPROVER NEEDS, here, at request time.
    //
    // The principal's approval is the thing that ends a child's access, and the
    // approvals list gave them a title and nothing else — no classes, no money
    // owed, no note. Recomputing that per row would be one query per request in
    // a list; and a figure recomputed at approval time answers a different
    // question anyway. What the approver should judge is what was true when the
    // exit was raised.
    const money = formatMoney(preview.outstandingMinor, preview.currency);
    const summary = [
      `${preview.classNames.length} class${preview.classNames.length === 1 ? "" : "es"}`,
      preview.classNames.length ? preview.classNames.join(", ") : null,
      preview.outstandingMinor > 0 ? `${money} still outstanding` : "nothing outstanding",
      reason?.trim() || null,
    ]
      .filter(Boolean)
      .join(" · ");

    const req = (await this.workflow.createRequest(p, {
      type: "STUDENT_EXIT",
      title: `Student exit — ${preview.studentName} (${kind.toLowerCase()})`,
      payload: { studentId, kind, reason: reason ?? null, summary },
      stages: [...STUDENT_EXIT_CHAIN],
    })) as { id: string };
    await this.workflow.submit(p, req.id);
    return { pendingApproval: true as const, requestId: req.id };
  }

  /**
   * Apply the exit. Called ONLY by the reactor above — never exposed, so there
   * is no route by which a single person can end a pupil's access.
   */
  private async applyExit(
    tx: TenantTx,
    schoolId: string,
    actorId: string,
    studentId: string,
    kind: ExitKind,
    reason?: string,
  ): Promise<void> {
    const now = new Date();
    // 1. ACCESS. This is the line that actually ends it: login refuses any
    //    status but ACTIVE. Guarded on ACTIVE so a replayed reactor cannot
    //    overwrite a status somebody has since changed.
    await tx.user.updateMany({
      where: { id: studentId, status: "ACTIVE" },
      data: { status: "EXITED", exitedAt: now },
    });
    // 2. ENROLMENTS — every one, not just the class the request came from. A
    //    pupil in three classes withdrawn from one was the old bug.
    await tx.enrollment.updateMany({
      where: { studentId, status: "ACTIVE" },
      data: { status: kind, statusReason: reason ?? null },
    });
    // 3. THEIR BED AND THEIR BUS SEAT.
    //
    // These are not paperwork. The hostel allocation list IS the night roll
    // call — the list staff use to account for children in the building — and
    // the route assignment list IS the driver's manifest. Leaving a departed
    // child on either means staff looking for someone who is not there, and a
    // register that stops being trusted the first time it is wrong.
    //
    // They also hold a bed and a seat that a real boarder cannot be given, and
    // the rent run bills on ACTIVE allocations: verified live, a pupil whose
    // exit two people had approved was invoiced 150000 minor units for next
    // month's boarding.
    //
    // Same reasoning as the enrolments above — a departure closes the things
    // the departure ends, in the same transaction, so a pupil is never half
    // gone. History is retained: both tables keep the row and move its status.
    await tx.hostelAllocation.updateMany({
      where: { studentId, status: "ACTIVE" },
      data: { status: "VACATED" },
    });
    await tx.transportAssignment.updateMany({
      where: { passengerId: studentId, status: "ACTIVE" },
      data: { status: "CANCELLED" },
    });
    await this.audit.record(
      {
        actorId,
        action: "student.exit.applied",
        entity: "user",
        entityId: studentId,
        schoolId,
        metadata: { kind, reason: reason ?? null },
      },
      tx,
    );
  }

  /**
   * RE-ADMIT a pupil who left — restores access and nothing else.
   *
   * Deliberately principal-only and a single step. The two-stage chain exists
   * to stop one person REMOVING a child's access; restoring it is the safe
   * direction, and requiring a committee to undo a mistake is how mistakes
   * stay in place. Their enrolments are NOT reinstated: which class they
   * rejoin is a decision, not a reversal.
   */
  async readmit(p: Principal, studentId: string, reason?: string): Promise<{ readmitted: boolean }> {
    return this.db.runAsTenant(this.ctx(p), async (tx) => {
      const changed = await tx.user.updateMany({
        where: { id: studentId, status: "EXITED" },
        data: { status: "ACTIVE", exitedAt: null },
      });
      if (changed.count === 0) throw new NotFoundException("No exited student to re-admit");
      await this.audit.record(
        { actorId: p.userId, action: "student.exit.readmitted", entity: "user", entityId: studentId, schoolId: p.schoolId, metadata: { reason: reason ?? null } },
        tx,
      );
      return { readmitted: true };
    });
  }

  /**
   * The leavers register: who has left, newest first, with how long each record
   * still has to run.
   *
   * THIS LIST IS NOW LOad-BEARING. Leavers are correctly gone from the student
   * list, the pickers and search — so this page is the ONLY way staff can reach
   * a departed pupil to issue the transcript or data export they are entitled
   * to. Losing them from every surface at once would have traded one problem
   * for a worse one.
   *
   * Paged, because it only ever grows.
   */
  async listExited(p: Principal, page = 1, pageSize = 25) {
    this.assertWholeSchool(p);
    const take = Math.min(100, Math.max(1, pageSize));
    const skip = (Math.max(1, page) - 1) * take;
    return this.db.runAsTenantReadOnly(this.ctx(p), async (tx) => {
      const rows = await tx.user.findMany({
        where: { status: "EXITED" },
        orderBy: { exitedAt: "desc" },
        skip,
        // One extra row to detect a next page — a COUNT here would scan every
        // user the school has ever had.
        take: take + 1,
        select: { id: true, name: true, email: true, exitedAt: true },
      });
      // The school's own retention policy, not a platform-wide one — the
      // statutory minimum for school records differs by country.
      const school = await tx.school.findFirst({
        where: { id: p.schoolId },
        select: { leaverRetentionYears: true },
      });
      const years = school?.leaverRetentionYears ?? 0;
      const now = Date.now();

      return {
        rows: rows.slice(0, take).map((r) => {
          // DUE FOR REVIEW, never "deleted". Nothing here disposes of anything;
          // this flags the record for a human, because the statutory floor
          // varies and destroying a child's academic history on a timer is the
          // more serious failure. 0 years disables the prompt entirely.
          const dueAt =
            years > 0 && r.exitedAt
              ? new Date(new Date(r.exitedAt).setFullYear(new Date(r.exitedAt).getFullYear() + years))
              : null;
          return { ...r, retentionDueAt: dueAt, dueForReview: dueAt != null && dueAt.getTime() <= now };
        }),
        page: Math.max(1, page),
        pageSize: take,
        hasMore: rows.length > take,
        retentionYears: years,
      };
    });
  }
}
