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

export interface ReminderResult {
  reminded: number;
  scanned: number;
  skipped?: "NO_DB";
}

@Injectable()
export class StaffReminderService {
  private readonly logger = new Logger("StaffReminder");

  constructor(
    @Inject(HR_REMINDER_DATABASE) private readonly db: PrivilegedDatabaseService,
    private readonly notifications: NotificationService,
  ) {}

  async sweep(): Promise<ReminderResult> {
    const client = this.db.client;
    if (!client) return { reminded: 0, scanned: 0, skipped: "NO_DB" };
    const cutoff = new Date(Date.now() + 30 * 86_400_000);
    const due = await client.staffDocument.findMany({
      where: { reminderSentAt: null, expiresAt: { not: null, lte: cutoff } },
      select: { id: true, schoolId: true, userId: true, kind: true, name: true, expiresAt: true },
    });
    if (due.length === 0) return { reminded: 0, scanned: 0 };

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
    return { reminded: due.length, scanned: due.length };
  }
}
