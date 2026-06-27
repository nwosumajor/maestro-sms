// =============================================================================
// BillingDunningService — scheduled renewal reminders + past-due downgrade
// =============================================================================
// A privileged, cross-tenant sweep (see BillingDatabaseService): for each school
// subscription it either (a) sends a renewal reminder when the period end is
// near, or (b) flips an ACTIVE subscription whose period has ELAPSED to PAST_DUE.
// It NEVER deletes data and NEVER touches the purchased `plan` — the downgrade to
// BASIC is enforced downstream by ModuleEntitlementService (effective plan) after
// the grace window, so a payment restores access automatically.
//
// The sweep has no HTTP actor, so it audits via the Logger + the status column
// rather than AuditLog (whose actorId is a non-null FK). The MANUAL trigger
// (super_admin) writes one audit entry in the caller's own tenant.
// =============================================================================

import { Inject, Injectable, Logger } from "@nestjs/common";
import { RENEWAL_REMINDER_DAYS, SUBSCRIPTION_STATUS } from "@sms/types";
import { ModuleEntitlementService } from "../foundation/module-entitlement.service";
import { NotificationService } from "../notifications/notification.service";
import { BILLING_DATABASE } from "./billing.constants";
import { BillingDatabaseService } from "./billing-database.service";

export type DunningTrigger = "SCHEDULED" | "MANUAL";

export interface DunningResult {
  reminded: number;
  pastDue: number;
  scanned: number;
  skipped?: "NO_DB";
}

function addDays(from: Date, days: number): Date {
  return new Date(from.getTime() + days * 24 * 60 * 60 * 1000);
}

@Injectable()
export class BillingDunningService {
  private readonly logger = new Logger("BillingDunning");

  constructor(
    @Inject(BILLING_DATABASE) private readonly db: BillingDatabaseService,
    private readonly entitlements: ModuleEntitlementService,
    private readonly notifications: NotificationService,
  ) {}

  /** Sweep every tenant's subscription. Cross-tenant + privileged by design. */
  async sweep(trigger: DunningTrigger = "SCHEDULED"): Promise<DunningResult> {
    const client = this.db.client;
    if (!client) {
      this.logger.warn("Dunning sweep requested but no privileged DB — skipping.");
      return { reminded: 0, pastDue: 0, scanned: 0, skipped: "NO_DB" };
    }
    const now = new Date();
    const subs = await client.schoolSubscription.findMany({
      where: { status: SUBSCRIPTION_STATUS.ACTIVE, currentPeriodEnd: { not: null } },
      select: { id: true, schoolId: true, currentPeriodEnd: true, plan: true },
    });

    let reminded = 0;
    let pastDue = 0;
    for (const s of subs) {
      if (!s.currentPeriodEnd) continue;
      if (s.currentPeriodEnd < now) {
        await client.schoolSubscription.update({
          where: { id: s.id },
          data: { status: SUBSCRIPTION_STATUS.PAST_DUE },
        });
        this.entitlements.invalidate(s.schoolId);
        pastDue++;
        await this.notifyAdmins(
          client,
          s.schoolId,
          "Subscription past due",
          `Your ${s.plan} plan payment is overdue. Renew within ${RENEWAL_REMINDER_DAYS} days to avoid a downgrade to the BASIC plan.`,
        );
      } else if (s.currentPeriodEnd <= addDays(now, RENEWAL_REMINDER_DAYS)) {
        reminded++;
        await this.notifyAdmins(
          client,
          s.schoolId,
          "Subscription renewal due soon",
          `Your ${s.plan} plan renews on ${s.currentPeriodEnd.toDateString()}. Renew to keep your modules enabled.`,
        );
      }
    }

    this.logger.log(`Dunning sweep (${trigger}): scanned=${subs.length} reminded=${reminded} pastDue=${pastDue}`);
    return { reminded, pastDue, scanned: subs.length };
  }

  /** Best-effort in-app notice to a school's principals/admins. Never throws. */
  private async notifyAdmins(
    client: BillingDatabaseService["client"],
    schoolId: string,
    title: string,
    body: string,
  ): Promise<void> {
    if (!client) return;
    try {
      const admins = await client.userRole.findMany({
        where: { schoolId, role: { name: { in: ["principal", "school_admin"] } } },
        select: { userId: true },
        distinct: ["userId"],
      });
      for (const a of admins) {
        await this.notifications.enqueue(
          { schoolId, userId: a.userId },
          { recipientId: a.userId, type: "BILLING", title, body },
        );
      }
    } catch (e) {
      this.logger.warn(`notifyAdmins failed for school ${schoolId}: ${(e as Error).message}`);
    }
  }
}
