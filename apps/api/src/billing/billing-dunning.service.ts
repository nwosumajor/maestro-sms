// =============================================================================
// BillingDunningService — scheduled renewal reminders + past-due downgrade
// =============================================================================
// A privileged, cross-tenant sweep (see BillingDatabaseService): for each school
// subscription it either (a) sends a renewal reminder when the period end is
// near, or (b) flips an ACTIVE subscription whose period has ELAPSED to PAST_DUE.
// It NEVER deletes data and NEVER touches the purchased `plan` — the downgrade to
// The STANDARD floor is enforced downstream by ModuleEntitlementService (effective plan) after
// the grace window, so a payment restores access automatically.
//
// The sweep has no HTTP actor, so it audits via the Logger + the status column
// rather than AuditLog (whose actorId is a non-null FK). The MANUAL trigger
// (super_admin) writes one audit entry in the caller's own tenant.
// =============================================================================

import { Inject, Injectable, Logger } from "@nestjs/common";
import {
  BILLING_CYCLES,
  CURRENCIES,
  RENEWAL_REMINDER_DAYS,
  SUBSCRIPTION_GRACE_DAYS,
  SUBSCRIPTION_STATUS,
  computeSubscriptionPriceMinor,
  isBillingCycle,
  isPlan,
  type BillingCycle,
  type Plan,
} from "@sms/types";
import { ModuleEntitlementService } from "../foundation/module-entitlement.service";
import { NotificationService } from "../notifications/notification.service";
import { BILLING_DATABASE } from "./billing.constants";
import { PrivilegedDatabaseService } from "../common/privileged-database.service";
import { PaystackService } from "../payments/paystack.service";
import { PlanPricingService } from "./plan-pricing.service";
import { decryptField } from "../foundation/field-crypto";

export type DunningTrigger = "SCHEDULED" | "MANUAL";

/** How close to the period end the saved-card renewal charge is attempted. */
const AUTO_RENEW_LEAD_DAYS = 2;

export interface DunningResult {
  reminded: number;
  pastDue: number;
  scanned: number;
  /** Lapsed schools reported to the platform owners in the red alert. */
  alerted: number;
  /** Saved-card renewal charges attempted / declined this sweep. */
  autoRenewCharged: number;
  autoRenewFailed: number;
  skipped?: "NO_DB";
}

function addDays(from: Date, days: number): Date {
  return new Date(from.getTime() + days * 24 * 60 * 60 * 1000);
}

@Injectable()
export class BillingDunningService {
  private readonly logger = new Logger("BillingDunning");

  constructor(
    @Inject(BILLING_DATABASE) private readonly db: PrivilegedDatabaseService,
    private readonly entitlements: ModuleEntitlementService,
    private readonly notifications: NotificationService,
    private readonly paystack: PaystackService,
    private readonly pricing: PlanPricingService,
  ) {}

  /** Sweep every tenant's subscription. Cross-tenant + privileged by design. */
  async sweep(trigger: DunningTrigger = "SCHEDULED"): Promise<DunningResult> {
    const client = this.db.client;
    if (!client) {
      this.logger.warn("Dunning sweep requested but no privileged DB — skipping.");
      return { reminded: 0, pastDue: 0, scanned: 0, alerted: 0, autoRenewCharged: 0, autoRenewFailed: 0, skipped: "NO_DB" };
    }
    const now = new Date();
    const subs = await client.schoolSubscription.findMany({
      where: { status: SUBSCRIPTION_STATUS.ACTIVE, currentPeriodEnd: { not: null } },
      select: {
        id: true,
        schoolId: true,
        currentPeriodEnd: true,
        plan: true,
        graceDays: true,
        billingCycle: true,
        currency: true,
        autoRenew: true,
        paystackAuthorizationEnc: true,
      },
    });

    let reminded = 0;
    let pastDue = 0;
    let autoRenewCharged = 0;
    let autoRenewFailed = 0;
    for (const s of subs) {
      if (!s.currentPeriodEnd) continue;
      // Saved-card auto-renew: attempt the charge shortly BEFORE the period
      // lapses (and while recently lapsed) — success flows through the normal
      // webhook apply (idempotent on reference), so this only INITIATES.
      if (
        s.autoRenew &&
        s.paystackAuthorizationEnc &&
        s.currency !== CURRENCIES.USD && // Paystack (NGN) only
        s.currentPeriodEnd <= addDays(now, AUTO_RENEW_LEAD_DAYS)
      ) {
        const outcome = await this.attemptAutoRenew(client, s, now);
        if (outcome === "charged") {
          autoRenewCharged++;
          continue; // the webhook will extend; no reminder / no flip today
        }
        if (outcome === "failed") autoRenewFailed++;
        // "skipped" (recent attempt pending) falls through to normal handling.
      }
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
          `Your ${s.plan} plan payment is overdue. Renew within ${s.graceDays ?? SUBSCRIPTION_GRACE_DAYS} days to avoid a downgrade to the Standard plan.`,
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

    // RED ALERT to the platform owners: one aggregated daily digest of EVERY
    // school currently past its paid period (new flips + still-unpaid + already
    // downgraded past grace), so a lapsed school can never sit unnoticed.
    const alerted = await this.alertPlatformOwners(client);

    this.logger.log(
      `Dunning sweep (${trigger}): scanned=${subs.length} reminded=${reminded} pastDue=${pastDue} alerted=${alerted} autoRenew=${autoRenewCharged}/${autoRenewCharged + autoRenewFailed}`,
    );
    return { reminded, pastDue, scanned: subs.length, alerted, autoRenewCharged, autoRenewFailed };
  }

  /**
   * One saved-card renewal attempt for a due subscription: price the CURRENT
   * seat count at the sub's plan/cycle, record a PENDING payment, charge the
   * stored authorization. Success is applied by the account webhook (idempotent
   * on the reference) — this method only initiates. At most one attempt per
   * ~20h (paced by the last AUTO- reference), so a declining card is retried
   * daily until grace runs out, never hammered.
   */
  private async attemptAutoRenew(
    client: NonNullable<PrivilegedDatabaseService["client"]>,
    s: {
      id: string;
      schoolId: string;
      plan: string;
      billingCycle: string;
      paystackAuthorizationEnc: string | null;
    },
    now: Date,
  ): Promise<"charged" | "failed" | "skipped"> {
    try {
      // Pace: skip if an auto-renew attempt was already made in the last ~20h.
      const recent = await client.platformSubscriptionPayment.findFirst({
        where: {
          schoolId: s.schoolId,
          reference: { startsWith: "AUTO-" },
          createdAt: { gte: new Date(now.getTime() - 20 * 3600 * 1000) },
        },
        select: { id: true },
      });
      if (recent) return "skipped";

      const plan: Plan = isPlan(s.plan) ? s.plan : "STANDARD";
      const cycle: BillingCycle = isBillingCycle(s.billingCycle) ? s.billingCycle : BILLING_CYCLES.TERM;
      // Current seats: distinct student-role users — the SAME definition
      // checkout bills (one definition of "student" platform-wide).
      const seatRows = await client.userRole.findMany({
        where: { schoolId: s.schoolId, role: { name: "student" } },
        select: { userId: true },
        distinct: ["userId"],
      });
      const seats = Math.max(1, seatRows.length);
      const pricing = await this.pricing.effective(CURRENCIES.NGN);
      const amountMinor = computeSubscriptionPriceMinor(plan, seats, cycle, pricing);

      // The charge needs a customer email — the school's first admin.
      const admin = await client.userRole.findFirst({
        where: { schoolId: s.schoolId, role: { name: { in: ["school_admin", "principal"] } } },
        select: { userId: true, user: { select: { email: true } } },
      });
      if (!admin?.user.email) return "failed";

      const reference = `AUTO-${s.schoolId.slice(0, 8)}-${now.getTime()}`;
      await client.platformSubscriptionPayment.create({
        data: {
          schoolId: s.schoolId,
          plan,
          billingCycle: cycle,
          seats,
          amountMinor,
          currency: CURRENCIES.NGN,
          reference,
          status: "PENDING",
          initiatedById: admin.userId,
        },
      });
      const charge = await this.paystack.chargeAuthorization({
        email: admin.user.email,
        amountMinor,
        reference,
        authorizationCode: decryptField(s.paystackAuthorizationEnc!, s.schoolId)!,
        metadata: { kind: "subscription", schoolId: s.schoolId, reference, auto: true },
      });
      if (charge.ok) {
        this.logger.log(`auto-renew charged school=${s.schoolId} ${amountMinor} kobo (${reference})`);
        return "charged";
      }
      await client.platformSubscriptionPayment.updateMany({
        where: { reference, status: "PENDING" },
        data: { status: "FAILED" },
      });
      await this.notifyAdmins(
        client,
        s.schoolId,
        "Auto-renewal failed — card declined",
        `We tried to renew your ${plan} plan with your saved card but the charge did not go through. Please renew manually from the Billing page (or update the card by paying once).`,
      );
      return "failed";
    } catch (e) {
      this.logger.warn(`auto-renew attempt failed for school ${s.schoolId}: ${(e as Error).message}`);
      return "failed";
    }
  }

  /** One aggregated OPERATOR_ALERT (in-app red + email) per super_admin listing
   *  all currently-lapsed schools. Best-effort: an alert failure never fails the
   *  sweep. Returns the number of lapsed schools reported (0 = nothing to say). */
  private async alertPlatformOwners(client: NonNullable<PrivilegedDatabaseService["client"]>): Promise<number> {
    try {
      const now = new Date();
      const lapsed = await client.schoolSubscription.findMany({
        where: { status: SUBSCRIPTION_STATUS.PAST_DUE },
        select: { schoolId: true, plan: true, currentPeriodEnd: true, graceDays: true },
      });
      if (lapsed.length === 0) return 0;

      const schools = await client.school.findMany({
        where: { id: { in: lapsed.map((s) => s.schoolId) } },
        select: { id: true, name: true },
      });
      const nameOf = new Map(schools.map((s) => [s.id, s.name]));

      const lines = lapsed
        .map((s) => {
          const end = s.currentPeriodEnd ? new Date(s.currentPeriodEnd) : null;
          const daysPast = end ? Math.max(0, Math.floor((now.getTime() - end.getTime()) / 86_400_000)) : 0;
          const grace = s.graceDays ?? SUBSCRIPTION_GRACE_DAYS; // per-school override wins
          const downgraded = daysPast > grace;
          return {
            daysPast,
            text: `${nameOf.get(s.schoolId) ?? s.schoolId} (${s.plan}) — ${daysPast} day${daysPast === 1 ? "" : "s"} past due, ${
              downgraded ? "DOWNGRADED to Standard" : `${grace - daysPast} grace day(s) left`
            }`,
          };
        })
        .sort((a, b) => b.daysPast - a.daysPast);
      const shown = lines.slice(0, 12).map((l) => l.text);
      if (lines.length > shown.length) shown.push(`…and ${lines.length - shown.length} more`);

      const owners = await client.user.findMany({
        where: { roles: { some: { role: { name: "super_admin" } } } },
        select: { id: true, schoolId: true },
      });
      for (const owner of owners) {
        await this.notifications.enqueue(
          { schoolId: owner.schoolId, userId: owner.id },
          {
            recipientId: owner.id,
            type: "OPERATOR_ALERT",
            title: `Billing alert: ${lines.length} school${lines.length === 1 ? "" : "s"} past due`,
            body: `${shown.join("\n")}\n\nReview and act in the operator console (extend, comp, or restore on payment).`,
            data: { lapsed: lines.length },
            channels: ["EMAIL"],
          },
        );
      }
      return lines.length;
    } catch (e) {
      this.logger.warn(`operator billing alert failed: ${(e as Error).message}`);
      return 0;
    }
  }

  /** Best-effort in-app notice to a school's principals/admins. Never throws. */
  private async notifyAdmins(
    client: PrivilegedDatabaseService["client"],
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
        // Renewal/past-due notices are revenue-critical: in-app AND email.
        await this.notifications.enqueue(
          { schoolId, userId: a.userId },
          { recipientId: a.userId, type: "BILLING", title, body, channels: ["EMAIL"] },
        );
      }
    } catch (e) {
      this.logger.warn(`notifyAdmins failed for school ${schoolId}: ${(e as Error).message}`);
    }
  }
}
