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
import { PLATFORM_HOME_CURRENCY, STUDENT_EXIT_CHAIN, formatMoney } from "@sms/types";
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
import { netPaidByInvoice } from "../fees/net-paid";

export type ExitKind = "WITHDRAWN" | "TRANSFERRED" | "GRADUATED";

/** Who may see exit information at all — whole-school staff. Mirrors the
 *  ROSTER_WIDE set used elsewhere; a class teacher is deliberately not here. */
const EXIT_VIEW_ROLES = new Set(["principal", "school_admin", "head_teacher", "junior_admin"]);

export interface StudentExitPreviewDto {
  studentId: string;
  studentName: string;
  classNames: string[];
  /** Money still owed IN `currency`, the school's own. A SIGNAL for the
   *  approver, never a block — a school that cannot release a leaver because of
   *  a debt has an NDPR problem, not a collections one. */
  outstandingMinor: number;
  currency: string;
  /** Every currency the pupil owes in, the school's own first and always
   *  present. The single figure used to be a sum across all of them wearing the
   *  school's currency as a label. */
  outstandingByCurrency: Array<{ currency: string; outstandingMinor: number }>;
  /** Library books still out. SURFACED, never auto-closed — see the note in
   *  preview(). */
  unreturnedBooks: string[];
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
   * RELEASE (or withhold) a leaver's academic documents.
   *
   * Principal-only, and the same person who authorises the exit. Schools
   * commonly hold a transcript or a leaving certificate until the family has
   * settled what they owe, and the platform gave them nowhere to record that —
   * so it happened in someone's head, or not at all.
   *
   * It gates ACADEMIC artefacts only: transcript, report card, certificate. It
   * deliberately does NOT gate the data-protection export. A data subject's
   * right to their own personal data is not a debt-collection lever, and
   * withholding it over money is unlawful rather than merely firm.
   *
   * Reversible in both directions, because a release given on a promise that is
   * not kept has to be retractable, and a release withheld in error has to be
   * grantable without a committee.
   */
  async setDocumentRelease(
    p: Principal,
    studentId: string,
    released: boolean,
    reason?: string,
  ): Promise<{ docsReleased: boolean }> {
    this.assertWholeSchool(p);
    return this.db.runAsTenant(this.ctx(p), async (tx) => {
      const changed = await tx.user.updateMany({
        where: { id: studentId, status: "EXITED" },
        data: released
          ? { docsReleasedAt: new Date(), docsReleasedById: p.userId }
          : { docsReleasedAt: null, docsReleasedById: null },
      });
      // 404-not-403 for anyone who is not a leaver of this school.
      if (changed.count === 0) throw new NotFoundException("No exited student found");
      await this.audit.record(
        {
          actorId: p.userId,
          action: released ? "student.documents.released" : "student.documents.withheld",
          entity: "user",
          entityId: studentId,
          schoolId: p.schoolId,
          metadata: { reason: reason ?? null },
        },
        tx,
      );
      return { docsReleased: released };
    });
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
      //
      // GROUPED BY CURRENCY. An invoice carries its own — a family billed in
      // dollars through the Stripe rail alongside the school's local currency —
      // so the ungrouped version added cents to kobo and then LABELLED the sum
      // with the school's currency, on the screen where somebody signs off a
      // pupil's departure and the family's last chance to settle.
      const school = await tx.school.findFirst({ where: { id: p.schoolId }, select: { currency: true } });
      const schoolCurrency = school?.currency ?? PLATFORM_HOME_CURRENCY;
      const owed = (await tx.invoice.groupBy({
        by: ["currency"],
        // Billable states only — DRAFT is not owed yet and CANCELLED never was.
        where: { studentId, status: { in: ["ISSUED", "PARTIALLY_PAID"] } },
        _sum: { totalMinor: true },
      })) as unknown as Array<{ currency: string; _sum: { totalMinor: number | null } }>;
      // Net of refunds. `kind: "PAYMENT"` excluded them, so a refunded invoice
      // made a leaver look LESS in debt than they are — on the screen where a
      // transcript is released or withheld.
      const paidByInvoice = await netPaidByInvoice(tx, { invoice: { studentId } });
      const paid = [...paidByInvoice].map(([invoiceId, amt]) => ({
        invoiceId,
        _sum: { amountMinor: amt },
      }));
      // A payment has no currency of its own, so map each back to its invoice.
      const invoiceCurrency = new Map(
        (
          (await tx.invoice.findMany({
            where: { studentId, status: { in: ["ISSUED", "PARTIALLY_PAID"] } },
            select: { id: true, currency: true },
          })) as Array<{ id: string; currency: string }>
        ).map((i) => [i.id, i.currency]),
      );
      const balances = new Map<string, number>();
      for (const o of owed) balances.set(o.currency, (balances.get(o.currency) ?? 0) + (o._sum.totalMinor ?? 0));
      for (const pmt of paid) {
        const c = invoiceCurrency.get(pmt.invoiceId);
        if (!c) continue; // a payment on a settled or cancelled invoice — not owed
        balances.set(c, (balances.get(c) ?? 0) - (pmt._sum.amountMinor ?? 0));
      }
      // The school's own currency leads and is always present, even at zero:
      // `outstandingMinor` is what the approval screen and the exit workflow
      // read as "what this family owes us".
      const outstandingByCurrency = [schoolCurrency, ...[...balances.keys()].filter((c) => c !== schoolCurrency).sort()].map(
        (currency) => ({ currency, outstandingMinor: Math.max(0, balances.get(currency) ?? 0) }),
      );

      // BOOKS STILL OUT.
      //
      // Deliberately shown to the approver and NOT closed by the exit, which is
      // the opposite of what the exit does to a bed and a bus seat. A pupil
      // leaving DOES vacate their bed — the fact and the record agree. A pupil
      // leaving does NOT return their books: marking those loans returned would
      // record something that did not happen, put a copy back on the shelf that
      // is not there, and quietly close the school's only claim on it.
      //
      // So the approver is told, before they approve, and can chase the books
      // while the family is still reachable. Afterwards is much harder.
      const loans = await tx.bookLoan.findMany({
        where: { borrowerId: studentId, status: "ISSUED" },
        select: { bookId: true },
      });
      const titles = loans.length
        ? await tx.libraryBook.findMany({
            where: { id: { in: loans.map((l) => l.bookId) } },
            select: { title: true },
          })
        : [];

      return {
        studentId,
        studentName: student.name,
        classNames: (enrolments as Array<{ class: { name: string } | null }>).map((e) => e.class?.name ?? "—"),
        outstandingMinor: outstandingByCurrency[0].outstandingMinor,
        currency: schoolCurrency,
        outstandingByCurrency,
        unreturnedBooks: titles.map((t) => t.title),
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
      preview.unreturnedBooks.length
        ? `${preview.unreturnedBooks.length} library book${preview.unreturnedBooks.length === 1 ? "" : "s"} not returned`
        : null,
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
        select: { id: true, name: true, email: true, exitedAt: true, docsReleasedAt: true },
      });
      // The school's own retention policy, not a platform-wide one — the
      // statutory minimum for school records differs by country.
      const school = await tx.school.findFirst({
        where: { id: p.schoolId },
        select: { leaverRetentionYears: true, currency: true },
      });
      const years = school?.leaverRetentionYears ?? 0;
      const leaverCurrency = school?.currency ?? PLATFORM_HOME_CURRENCY;
      const now = Date.now();

      // WHAT EACH LEAVER STILL OWES.
      //
      // TWO grouped queries for the whole page, not two per row: this list is
      // paged but a school's leavers only ever grow, and a per-row balance is
      // the shape that turns a fast page into a slow one three years in.
      //
      // AND BY CURRENCY. The list renders one figure per leaver under one
      // symbol, so a pupil billed in dollars alongside the school's own currency
      // had cents added to kobo — the same defect as the exit preview above, in
      // the list that feeds the bursar's chase.
      const ids = rows.slice(0, take).map((r) => r.id);
      const [billed, paid] = ids.length
        ? await Promise.all([
            tx.invoice.groupBy({
              by: ["studentId", "currency"],
              where: { studentId: { in: ids }, status: { in: ["ISSUED", "PARTIALLY_PAID"] } },
              _sum: { totalMinor: true },
            }),
            netPaidByInvoice(tx, { invoice: { studentId: { in: ids } } }).then((m) =>
              [...m].map(([invoiceId, amt]) => ({ invoiceId, _sum: { amountMinor: amt } })),
            ),
          ])
        : [[], []];
      // Payments group by invoice, so map them back to the pupil AND to the
      // currency the invoice was raised in — a payment has neither of its own.
      const invoices = ids.length
        ? await tx.invoice.findMany({
            where: { studentId: { in: ids } },
            select: { id: true, studentId: true, currency: true },
          })
        : [];
      const studentOfInvoice = new Map(
        (invoices as Array<{ id: string; studentId: string; currency: string }>).map((i) => [i.id, i]),
      );

      // WHY THEY LEFT.
      //
      // The exit captures both — the kind (transferred / withdrawn / graduated)
      // onto every enrolment's status, and the free-text note onto
      // statusReason. Neither was ever read again anywhere in the API or the
      // web: a sweep for columns written and never read found `statusReason`
      // among 29 candidates, and it was the only true one.
      //
      // So a leavers register could tell a school WHO left and when, and not
      // whether they graduated or were withdrawn — the first question anybody
      // asks of that list, and the one the school already answered when it
      // approved the exit.
      //
      // ONE query for the page, keyed by pupil. Their enrolments all carry the
      // same kind (the exit sets them together), so the most recent is the
      // exit's own record.
      const exitRows = ids.length
        ? await tx.enrollment.findMany({
            where: { studentId: { in: ids }, status: { not: "ACTIVE" } },
            select: { studentId: true, status: true, statusReason: true, enrolledAt: true },
            orderBy: { enrolledAt: "desc" },
          })
        : [];
      const reasonOf = new Map<string, { kind: string; reason: string | null }>();
      for (const e of exitRows as Array<{ studentId: string; status: string; statusReason: string | null }>) {
        if (!reasonOf.has(e.studentId)) reasonOf.set(e.studentId, { kind: e.status, reason: e.statusReason });
      }
      // Keyed on pupil AND currency, so two kinds of money never meet.
      const owedBy = new Map<string, number>();
      const key = (studentId: string, currency: string) => `${studentId}|${currency}`;
      for (const b of billed as Array<{ studentId: string; currency: string; _sum: { totalMinor: number | null } }>) {
        owedBy.set(key(b.studentId, b.currency), (owedBy.get(key(b.studentId, b.currency)) ?? 0) + (b._sum.totalMinor ?? 0));
      }
      for (const pmt of paid as Array<{ invoiceId: string; _sum: { amountMinor: number | null } }>) {
        const inv = studentOfInvoice.get(pmt.invoiceId);
        if (!inv) continue;
        const k = key(inv.studentId, inv.currency);
        owedBy.set(k, (owedBy.get(k) ?? 0) - (pmt._sum.amountMinor ?? 0));
      }
      const owedByStudent = new Map<string, Array<{ currency: string; outstandingMinor: number }>>();
      for (const [k, minor] of owedBy) {
        const [studentId, currency] = k.split("|");
        const owedMinor = Math.max(0, minor);
        if (owedMinor === 0) continue;
        (owedByStudent.get(studentId) ?? owedByStudent.set(studentId, []).get(studentId)!).push({
          currency,
          outstandingMinor: owedMinor,
        });
      }
      for (const list of owedByStudent.values()) {
        list.sort((a, b) => (a.currency === leaverCurrency ? -1 : b.currency === leaverCurrency ? 1 : a.currency.localeCompare(b.currency)));
      }

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
          return {
            ...r,
            retentionDueAt: dueAt,
            dueForReview: dueAt != null && dueAt.getTime() <= now,
            // Never negative: an overpayment is a credit, not a debt, and
            // showing "owes -5,000" on a leavers page is how a bursar chases
            // somebody who owes nothing.
            //
            // The headline is the SCHOOL's own currency; anything else the
            // pupil owes is listed beside it rather than added into it.
            outstandingMinor:
              owedByStudent.get(r.id)?.find((b) => b.currency === leaverCurrency)?.outstandingMinor ?? 0,
            outstandingByCurrency: owedByStudent.get(r.id) ?? [],
            docsReleased: r.docsReleasedAt != null,
            exitKind: reasonOf.get(r.id)?.kind ?? null,
            exitReason: reasonOf.get(r.id)?.reason ?? null,
          };
        }),
        page: Math.max(1, page),
        pageSize: take,
        hasMore: rows.length > take,
        retentionYears: years,
        currency: school?.currency ?? "NGN",
      };
    });
  }
}
