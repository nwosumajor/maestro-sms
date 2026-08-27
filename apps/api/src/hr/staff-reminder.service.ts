// =============================================================================
// StaffReminderService — scheduled cross-tenant staff-document expiry sweep
// =============================================================================
// A privileged, cross-tenant sweep (see HrReminderDatabaseService): finds staff
// documents expiring within 30 days that haven't been reminded, notifies each
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

export interface ReminderResult {
  reminded: number;
  scanned: number;
  /** Departed staff whose access this run actually closed. */
  accessRevoked?: number;
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
    const cutoff = new Date(Date.now() + 30 * 86_400_000);
    const due = await client.staffDocument.findMany({
      where: { reminderSentAt: null, expiresAt: { not: null, lte: cutoff } },
      select: { id: true, schoolId: true, userId: true, kind: true, name: true, expiresAt: true },
    });
    if (due.length === 0) return { reminded: 0, scanned: 0, accessRevoked };

    // Group due docs by school so we notify each school's HR.
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
        for (const d of docs) {
          for (const r of hr) {
            await this.notifications.enqueue(
              { schoolId, userId: r.userId },
              {
                recipientId: r.userId,
                type: "GENERIC",
                title: "Staff document expiring soon",
                body: `${nameById.get(d.userId) ?? "A staff member"}'s ${d.kind} (“${d.name}”) expires on ${d.expiresAt ? new Date(d.expiresAt).toISOString().slice(0, 10) : "soon"}.`,
              },
            );
          }
          await client.staffDocument.update({ where: { id: d.id }, data: { reminderSentAt: new Date() } });
        }
      } catch (e) {
        this.logger.warn(`reminder sweep failed for school ${schoolId}: ${(e as Error).message}`);
      }
    }
    this.logger.log(`Staff reminder sweep: scanned=${due.length} reminded=${due.length}`);
    await this.sweepContracts(client);
    return { reminded: due.length, scanned: due.length, accessRevoked };
  }

  /** Fixed-term contracts ending within 30 days: nudge each school's HR once
   *  (contractReminderSentAt stamps idempotency; a RENEWAL approval re-arms it). */
  private async sweepContracts(client: NonNullable<PrivilegedDatabaseService["client"]>): Promise<void> {
    const cutoff = new Date(Date.now() + 30 * 86_400_000);
    const ending = await client.employee.findMany({
      where: { status: "ACTIVE", contractReminderSentAt: null, endDate: { not: null, lte: cutoff } },
      select: { id: true, schoolId: true, userId: true, endDate: true },
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
        for (const e of emps) {
          for (const r of hr) {
            await this.notifications.enqueue(
              { schoolId, userId: r.userId },
              {
                recipientId: r.userId,
                type: "GENERIC",
                title: "Contract ending soon",
                body: `${nameById.get(e.userId) ?? "A staff member"}'s contract ends on ${e.endDate ? new Date(e.endDate).toISOString().slice(0, 10) : "soon"} — renew or start offboarding.`,
              },
            );
          }
          await client.employee.update({ where: { id: e.id }, data: { contractReminderSentAt: new Date() } });
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
