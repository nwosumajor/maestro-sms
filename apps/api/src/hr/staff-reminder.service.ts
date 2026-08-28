// =============================================================================
// StaffReminderService — scheduled cross-tenant staff-document expiry sweep
// =============================================================================
// A privileged, cross-tenant sweep (see HrReminderDatabaseService): finds staff
// documents within 30 days of expiry AND documents that have since lapsed,
// notifies each
// school's HR in-app, and stamps reminderSentAt (idempotent). Mirrors the billing
// dunning sweep. No HTTP actor; never deletes data.
// =============================================================================

import { Inject, Injectable, Logger } from "@nestjs/common";
import { NotificationService } from "../notifications/notification.service";
import { HR_NOTIFY_ROLES, HR_REMINDER_DATABASE } from "./hr.constants";
import { PrivilegedDatabaseService } from "../common/privileged-database.service";
import { endsOnOrBefore } from "./staff-access";
import { schoolToday } from "@sms/types";
import { SchoolRegionService } from "../foundation/school-region.service";
import {
  contractCandidateWhere,
  contractEndNotice,
  documentExpiryNotice,
  expiryCandidateWhere,
  expiryStage,
} from "./document-expiry";

export interface ReminderResult {
  reminded: number;
  scanned: number;
  /** Departed staff whose access this run actually closed. */
  accessRevoked?: number;
  /** Approved raises this run put into force on their effective date. */
  salaryChangesApplied?: number;
  skipped?: "NO_DB";
}

@Injectable()
export class StaffReminderService {
  private readonly logger = new Logger("StaffReminder");

  constructor(
    @Inject(HR_REMINDER_DATABASE) private readonly db: PrivilegedDatabaseService,
    private readonly notifications: NotificationService,
    // @Global and 60s-cached: resolving each school's day costs one lookup per
    // DISTINCT school with an elapsed exit, not one per row.
    private readonly region: SchoolRegionService,
  ) {}

  async sweep(): Promise<ReminderResult> {
    const client = this.db.client;
    if (!client) return { reminded: 0, scanned: 0, skipped: "NO_DB" };
    // Close the access of anyone whose last working day has now passed. This
    // runs FIRST and independently of the document reminders: a failure to
    // notify HR about an expiring certificate must never leave a departed
    // teacher's account open, so the two do not share a try block.
    const accessRevoked = await this.revokeElapsedExits(client);
    // Same reasoning, its own try block: a failed document reminder must never
    // leave an approved raise unpaid on the month it was due to start.
    const salaryChangesApplied = await this.applyDueSalaryChanges(client);
    // Candidates are a SUPERSET: this runs for the whole fleet before any
    // school's own day is known, and the stage is decided per school below.
    const due = await client.staffDocument.findMany({
      where: expiryCandidateWhere(new Date()),
      select: {
        id: true, schoolId: true, userId: true, kind: true, name: true,
        expiresAt: true, expiryNoticeStage: true,
      },
    });
    // NO EARLY RETURN. This used to be
    //     if (due.length === 0) return { ... };
    // and `sweepContracts` is called at the END of this method — so a school
    // with no expiring DOCUMENT never had its expiring CONTRACTS looked at.
    // `staff_document` was empty across the whole demo tenant, so that arm had
    // never run at all. The two arms directly above this one each carry a
    // comment explaining why they are independent; the third was guarded behind
    // the first's early exit.

    // Group due docs by school so we notify each school's HR.
    // COUNTED, NOT ASSUMED: the candidate set is a superset — a row whose stage
    // has not changed is scanned and deliberately not announced — so the two
    // numbers answer different questions and are reported separately.
    let notified = 0;
    const bySchool = new Map<string, typeof due>();
    for (const d of due) (bySchool.get(d.schoolId) ?? bySchool.set(d.schoolId, []).get(d.schoolId)!).push(d);

    for (const [schoolId, docs] of bySchool) {
      try {
        const hr = await client.userRole.findMany({
          where: { schoolId, role: { name: { in: HR_NOTIFY_ROLES } } },
          select: { userId: true },
          distinct: ["userId"],
        });
        const userIds = [...new Set(docs.map((d) => d.userId))];
        const owners = await client.user.findMany({ where: { id: { in: userIds } }, select: { id: true, name: true } });
        const nameById = new Map(owners.map((u) => [u.id, u.name]));
        // THE SCHOOL'S OWN DAY. `expiresAt` is a `@db.Date` — a DAY — and a
        // certificate is valid through the day it names, so which side of
        // expiry it falls on is a question about the school's calendar, not
        // the server's UTC one.
        const today = schoolToday((await this.region.forSchool(schoolId)).timezone);
        for (const d of docs) {
          const stage = expiryStage(d.expiresAt, today);
          // Only on a CHANGE: a document is announced at most twice, once
          // before it lapses and once when it does.
          if (!stage || stage === d.expiryNoticeStage) continue;
          const notice = documentExpiryNotice(
            { who: nameById.get(d.userId) ?? "A staff member", kind: d.kind, name: d.name, expiresAt: d.expiresAt },
            stage,
          );
          for (const r of hr) {
            await this.notifications.enqueue({ schoolId, userId: r.userId }, { recipientId: r.userId, type: "GENERIC", ...notice });
          }
          await client.staffDocument.update({
            where: { id: d.id },
            data: { reminderSentAt: new Date(), expiryNoticeStage: stage },
          });
          notified += 1;
        }
      } catch (e) {
        this.logger.warn(`reminder sweep failed for school ${schoolId}: ${(e as Error).message}`);
      }
    }
    this.logger.log(`Staff reminder sweep: scanned=${due.length} reminded=${notified}`);
    await this.sweepContracts(client);
    return { reminded: notified, scanned: due.length, accessRevoked, salaryChangesApplied };
  }

  /** Fixed-term contracts ending within 30 days: nudge each school's HR once
   *  (contractReminderSentAt stamps idempotency; a RENEWAL approval re-arms it). */
  private async sweepContracts(client: NonNullable<PrivilegedDatabaseService["client"]>): Promise<void> {
    const ending = await client.employee.findMany({
      where: contractCandidateWhere(new Date()),
      select: { id: true, schoolId: true, userId: true, endDate: true, contractNoticeStage: true },
    });
    if (ending.length === 0) return;
    const bySchool = new Map<string, typeof ending>();
    for (const e of ending) (bySchool.get(e.schoolId) ?? bySchool.set(e.schoolId, []).get(e.schoolId)!).push(e);
    for (const [schoolId, emps] of bySchool) {
      try {
        const hr = await client.userRole.findMany({
          where: { schoolId, role: { name: { in: HR_NOTIFY_ROLES } } },
          select: { userId: true },
          distinct: ["userId"],
        });
        const owners = await client.user.findMany({
          where: { id: { in: emps.map((e) => e.userId) } },
          select: { id: true, name: true },
        });
        const nameById = new Map(owners.map((u) => [u.id, u.name]));
        const today = schoolToday((await this.region.forSchool(schoolId)).timezone);
        for (const e of emps) {
          const stage = expiryStage(e.endDate, today);
          if (!stage || stage === e.contractNoticeStage) continue;
          const notice = contractEndNotice({ who: nameById.get(e.userId) ?? "A staff member", endDate: e.endDate }, stage);
          for (const r of hr) {
            await this.notifications.enqueue({ schoolId, userId: r.userId }, { recipientId: r.userId, type: "GENERIC", ...notice });
          }
          await client.employee.update({
            where: { id: e.id },
            data: { contractReminderSentAt: new Date(), contractNoticeStage: stage },
          });
        }
      } catch (err) {
        this.logger.warn(`contract reminder failed for school ${schoolId}: ${(err as Error).message}`);
      }
    }
    this.logger.log(`Contract reminder sweep: reminded=${ending.length}`);
  }

  /**
   * Close the account of every staff member whose exit is APPROVED and whose
   * last working day has passed.
   *
   * WHY A SWEEP AND NOT JUST THE APPROVAL. A staff exit is normally approved
   * before the person leaves — someone serving a month's notice still has to
   * teach — so the approval revokes access only when the last working day has
   * already arrived. Everyone else is picked up here, on the day.
   *
   * Cross-tenant and privileged, like the dunning sweep. Guarded on ACTIVE, so
   * re-running it is safe and it never reopens or overwrites a status a human
   * has since changed.
   */
  /**
   * Apply APPROVED salary changes whose effective date has arrived.
   *
   * A future-dated approval is deliberately NOT applied at approval time — the
   * effective date was previously recorded and ignored, so a raise dated for
   * October moved the salary in August and payroll paid it. This is the arm that
   * makes the date real, and it mirrors `revokeElapsedExits` exactly: privileged
   * and cross-tenant, each school's OWN day, guarded so a re-run cannot apply
   * the same change twice.
   */
  private async applyDueSalaryChanges(
    client: NonNullable<PrivilegedDatabaseService["client"]>,
  ): Promise<number> {
    try {
      const now = new Date();
      const due = await client.salaryChangeRequest.findMany({
        where: { status: "APPROVED", appliedAt: null, effectiveDate: { not: null, lte: now } },
        select: { id: true, schoolId: true, employeeId: true, newSalaryEnc: true, effectiveDate: true },
      });
      if (due.length === 0) return 0;
      const todayBySchool = new Map<string, Date>();
      for (const schoolId of new Set(due.map((d) => d.schoolId))) {
        todayBySchool.set(schoolId, schoolToday((await this.region.forSchool(schoolId)).timezone));
      }
      let applied = 0;
      for (const d of due) {
        const today = todayBySchool.get(d.schoolId) ?? now;
        if (!d.effectiveDate || new Date(d.effectiveDate) > today) continue;
        // Guarded on `appliedAt: null` in the WRITE, not just the read, so two
        // overlapping runs cannot both pay the same raise.
        const claim = await client.salaryChangeRequest.updateMany({
          where: { id: d.id, appliedAt: null },
          data: { appliedAt: now },
        });
        if (claim.count === 0) continue;
        await client.employee.update({ where: { id: d.employeeId }, data: { salaryEnc: d.newSalaryEnc } });
        applied += 1;
      }
      if (applied > 0) {
        this.logger.log(`applied ${applied} salary change(s) that reached their effective date`);
      }
      return applied;
    } catch (err) {
      this.logger.error(`salary effective-date sweep failed: ${(err as Error).message}`);
      return 0;
    }
  }

  private async revokeElapsedExits(
    client: NonNullable<PrivilegedDatabaseService["client"]>,
  ): Promise<number> {
    try {
      const now = new Date();
      const elapsed = await client.staffExit.findMany({
        where: { status: "APPROVED", lastWorkingDay: { lte: now } },
        select: { userId: true, schoolId: true, lastWorkingDay: true },
      });
      if (elapsed.length === 0) return 0;
      // One statement, not one per person: this is a fleet-wide nightly job and
      // the candidate set grows with every school's whole staff history.
      // EACH SCHOOL'S OWN DAY. The rows already carry `schoolId`, and the
      // fleet-wide sweep had everything it needed to ask and did not — so a
      // leaver west of UTC lost access during their final working day. Resolved
      // once per DISTINCT school (60s-cached), not once per row.
      const todayBySchool = new Map<string, Date>();
      for (const schoolId of new Set(elapsed.map((e) => e.schoolId))) {
        todayBySchool.set(schoolId, schoolToday((await this.region.forSchool(schoolId)).timezone));
      }
      const stillActive = elapsed.filter((e) =>
        endsOnOrBefore(e.lastWorkingDay, todayBySchool.get(e.schoolId) ?? now),
      );
      const result = await client.user.updateMany({
        where: { id: { in: [...new Set(stillActive.map((e) => e.userId))] }, status: "ACTIVE" },
        data: { status: "EXITED", exitedAt: now },
      });
      if (result.count > 0) {
        // Said out loud. An account closing is exactly the kind of thing whose
        // absence from the logs is noticed only during an incident.
        this.logger.log(`revoked access for ${result.count} departed staff member(s)`);
      }
      return result.count;
    } catch (err) {
      this.logger.error(`access revocation sweep failed: ${(err as Error).message}`);
      return 0;
    }
  }
}
