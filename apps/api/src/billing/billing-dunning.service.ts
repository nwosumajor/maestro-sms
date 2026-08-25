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
  accrueSeatArrearsMinor,
  computeSubscriptionPriceMinor,
  type ModuleOverrides,
  isBillingCycle,
  isCurrency,
  isPlan,
  type BillingCycle,
  type Currency,
  type Plan,
} from "@sms/types";
import { ModuleEntitlementService } from "../foundation/module-entitlement.service";
import { NotificationService } from "../notifications/notification.service";
import { BILLING_DATABASE } from "./billing.constants";
import { PrivilegedDatabaseService } from "../common/privileged-database.service";
import { ON_ROLL_STUDENT, STUDENT_ROLE } from "../common/student-scope";
import { PaystackService } from "../payments/paystack.service";
import { PlanPricingService } from "./plan-pricing.service";
import { decryptField } from "../foundation/field-crypto";
import { toMinor } from "../common/money";

export type DunningTrigger = "SCHEDULED" | "MANUAL";

/** How close to the period end the saved-card renewal charge is attempted. */
const AUTO_RENEW_LEAD_DAYS = 2;

/** How long a checkout intent may sit PENDING before it is treated as
 *  abandoned. Generous on purpose: marking a real payment abandoned is far
 *  worse than leaving a dead row visible a little longer. */
const ABANDON_INTENT_AFTER_HOURS = 48;

export interface DunningResult {
  reminded: number;
  pastDue: number;
  scanned: number;
  /**
   * SCHOOLS this run could not fully process — dunning threw, or the seat-arrears
   * accrual did, or both (counted once).
   *
   * The operator's jobs console reads this to decide its "Partial" badge, so a
   * failure it cannot see is a failure nobody acts on. The accrual used to be
   * outside it entirely.
   */
  failed: number;
  /** Of those, the ones whose SEAT METERING threw. They were dunned correctly;
   *  their seat growth simply went unmetered and is picked up next sweep. */
  arrearsFailed: number;
  /** Lapsed schools reported to the platform owners in the red alert. */
  alerted: number;
  /** Saved-card renewal charges attempted / declined this sweep. */
  autoRenewCharged: number;
  autoRenewFailed: number;
  /** Stale checkout intents closed off this sweep (see expireStaleIntents). */
  abandoned: number;
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
      return {
        reminded: 0, pastDue: 0, scanned: 0, failed: 0, arrearsFailed: 0, alerted: 0,
        autoRenewCharged: 0, autoRenewFailed: 0, abandoned: 0, skipped: "NO_DB",
      };
    }
    const now = new Date();
    // NOT a school the operator has switched off. DISABLED blocks every login,
    // so "renew now" would go to admins who cannot sign in to act on it — a loop
    // that cannot close, and a message from a platform that has already shut the
    // door. Their subscription state is untouched and resumes when the owner
    // switches them back on.
    const subs = await client.schoolSubscription.findMany({
      where: {
        status: SUBSCRIPTION_STATUS.ACTIVE,
        currentPeriodEnd: { not: null },
        school: { is: { status: "ACTIVE" } },
      },
      select: {
        id: true,
        schoolId: true,
        currentPeriodEnd: true,
        plan: true,
        graceDays: true,
        billingCycle: true,
        currency: true,
        seats: true,
        autoRenew: true,
        paystackAuthorizationEnc: true,
        arrearsAccruedAt: true,
        seatArrearsMinor: true,
        // Needed to bill add-ons on the renewal, same as checkout does.
        overrides: true,
      },
    });

    // Seat-arrears metering: one fleet-wide seat count, then per-sub accrual of
    // seat-days ABOVE the billed count since the last stamp. The stamp advances
    // every sweep (even at zero extra) so a later surge accrues only from its
    // own window, never from an ancient baseline.
    const arrearsFailedSchools = await this.accrueSeatArrears(client, subs, now);

    let reminded = 0;
    let pastDue = 0;
    let autoRenewCharged = 0;
    let autoRenewFailed = 0;
    // ONE SCHOOL'S FAILURE MUST NOT END THE RUN.
    //
    // Unguarded, a subscription that threw — a declined card that errored rather
    // than returning, a notification that could not be written — abandoned every
    // school after it: not flipped to PAST_DUE, not reminded, silently, and the
    // same way the next night. The attendance rollup and the late-fee sweep
    // already guard per item; this did not. Counted and returned, because the
    // job-runs catalogue is where an operator finds out.
    // A SCHOOL, not an incident: one school can fail both halves of the sweep and
    // must be reported once. `failed` is what the operator's jobs console reads
    // to decide its "Partial" badge, so it has to mean "schools this run could
    // not fully process" — the accrual half was invisible to it entirely.
    const failedSchools = new Set<string>(arrearsFailedSchools);
    for (const s of subs) {
      if (!s.currentPeriodEnd) continue;
      try {
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
      } catch (err) {
        failedSchools.add(s.schoolId);
        this.logger.error(`dunning failed for school ${s.schoolId}: ${(err as Error).message}`);
      }
    }

    // RED ALERT to the platform owners: one aggregated daily digest of EVERY
    // school currently past its paid period (new flips + still-unpaid + already
    // downgraded past grace), so a lapsed school can never sit unnoticed.
    const alerted = await this.alertPlatformOwners(client);

    const abandoned = await this.expireStaleIntents(client);

    this.logger.log(
      `Dunning sweep (${trigger}): scanned=${subs.length} reminded=${reminded} pastDue=${pastDue} alerted=${alerted} autoRenew=${autoRenewCharged}/${autoRenewCharged + autoRenewFailed} abandoned=${abandoned}`,
    );
    // `failed` is RETURNED, not merely logged: a sweep that reports "12 scanned,
    // 3 reminded" while four schools threw reads as a quiet night.
    return {
      reminded,
      pastDue,
      scanned: subs.length,
      failed: failedSchools.size,
      // Broken out because the two failures are not the same event: a school
      // whose dunning threw was NOT flipped and NOT reminded, while one whose
      // accrual threw was handled correctly and simply had its seat growth left
      // unmetered. Reporting them as one number would tell an operator to look
      // in the wrong place.
      arrearsFailed: arrearsFailedSchools.length,
      alerted,
      autoRenewCharged,
      autoRenewFailed,
      abandoned,
    };
  }

  /**
   * Daily seat-day metering. For every ACTIVE sub with a billed seat count:
   * accrue (currentSeats − billedSeats) × perSeatDaily × elapsed since the last
   * stamp (capped at the paid period end — lapsed time is dunning's job, not
   * the meter's). First sight of a sub only stamps the baseline. Best-effort:
   * a metering hiccup must never fail the sweep.
   */
  /**
   * Close off checkout intents that were never paid.
   *
   * A PENDING row is written before the school is sent to the gateway, so the
   * webhook has something to match. Most schools who click "upgrade" then look
   * at the price and close the tab — and that row stayed PENDING for ever.
   * PENDING on a payment history reads as "your money is on its way", so a
   * school with three abandoned attempts saw three payments apparently in
   * flight, which is both alarming and false.
   *
   * ABANDONED, not FAILED: nothing went wrong and nobody was charged. The
   * distinction matters to whoever reads this history looking for a problem.
   *
   * THE WINDOW IS DELIBERATELY GENEROUS. A gateway can deliver a webhook late,
   * a bank transfer against a checkout can take a day, and marking a real
   * payment abandoned would be far worse than leaving a dead row a while
   * longer. This is also SAFE against a late webhook regardless: settlement
   * matches on the reference and only refuses a row already PAID, so an
   * ABANDONED intent that finally pays still settles correctly.
   */
  private async expireStaleIntents(client: NonNullable<PrivilegedDatabaseService["client"]>): Promise<number> {
    const cutoff = new Date(Date.now() - ABANDON_INTENT_AFTER_HOURS * 3_600_000);
    try {
      const { count } = await client.platformSubscriptionPayment.updateMany({
        where: { status: "PENDING", createdAt: { lt: cutoff } },
        data: { status: "ABANDONED" },
      });
      return count;
    } catch (e) {
      // Never fail the whole sweep over bookkeeping — dunning matters more.
      this.logger.warn(`could not expire stale checkout intents: ${(e as Error).message}`);
      return 0;
    }
  }

  /**
   * Meter seat growth, ONE SCHOOL AT A TIME.
   *
   * Returns the schools whose accrual threw, so the sweep can count them.
   *
   * This loop used to sit inside a single try/catch: the first school that threw
   * abandoned every school after it, the failure was a single warn line naming
   * nobody, and `DunningResult.failed` — which is what the operator's jobs
   * console reads to decide its "Partial" badge — knew nothing about it. So the
   * console showed a clean green run while the platform metered no seat growth
   * at all.
   *
   * Reachable, and proved rather than theorised: a school sold in a currency
   * `CURRENCIES` supports but which has no `plan_price` rows makes
   * `PlanPricingService.effective` refuse — deliberately, since quoting a tier
   * at zero is worse than saying the market is not open. Live, two schools, one
   * of them GHS: BOTH accrued nothing and the sweep returned `failed: 0`.
   *
   * Third instance of the same lesson, after the retention and dunning sweeps —
   * and this one is the loop directly ABOVE the per-school guard those fixes
   * added, which is how it was missed.
   */
  private async accrueSeatArrears(
    client: NonNullable<PrivilegedDatabaseService["client"]>,
    subs: Array<{
      id: string;
      schoolId: string;
      plan: string;
      currency: string | null;
      seats: number | null;
      currentPeriodEnd: Date | null;
      arrearsAccruedAt: Date | null;
    }>,
    now: Date,
  ): Promise<string[]> {
    const failedSchools: string[] = [];
    try {
      // ON-ROLL seats per school, counted IN THE DATABASE.
      //
      // Two things were wrong here. It counted pupils who had LEFT, so a school
      // that exited a hundred children went on accruing arrears for them. And it
      // hydrated one row per student across the WHOLE FLEET through the ORM
      // purely to read a count — at 5,000 schools of ~900 pupils that is over
      // four million objects built and thrown away on a nightly sweep, which is
      // the shape that turns a background job into an outage as the platform
      // grows.
      //
      // `count(DISTINCT "userId")` keeps the distinct-user semantics in SQL,
      // where a duplicate role assignment cannot inflate a school's bill, and
      // returns one row per school instead of one per pupil.
      const seatRows = await client.$queryRaw<Array<{ schoolId: string; seats: bigint }>>`
        SELECT ur."schoolId" AS "schoolId", count(DISTINCT ur."userId") AS seats
        FROM user_role ur
        JOIN role r ON r.id = ur."roleId" AND r.name = ${STUDENT_ROLE}
        JOIN "user" u ON u.id = ur."userId" AND u.status = 'ACTIVE'
        WHERE ur."schoolId" = ANY(${subs.map((s) => s.schoolId)}::uuid[])
        GROUP BY ur."schoolId"
      `;
      const seatCount = new Map<string, number>();
      // int8 arrives as a BigInt and would break JSON downstream — narrow here.
      for (const r of seatRows) seatCount.set(r.schoolId, Number(r.seats));

      for (const s of subs) {
        if (!isPlan(s.plan) || s.seats == null || s.seats <= 0) continue; // never seat-billed (trial/comp)
        try {
          if (!s.arrearsAccruedAt) {
            // Baseline stamp — accrual starts from the NEXT sweep.
            await client.schoolSubscription.update({ where: { id: s.id }, data: { arrearsAccruedAt: now } });
            continue;
          }
          const windowEnd = s.currentPeriodEnd && s.currentPeriodEnd < now ? s.currentPeriodEnd : now;
          const elapsedMs = windowEnd.getTime() - s.arrearsAccruedAt.getTime();
          const currency: Currency = isCurrency(s.currency ?? "") ? (s.currency as Currency) : CURRENCIES.NGN;
          const pricing = await this.pricing.effective(currency);
          const accrued = accrueSeatArrearsMinor(s.plan, s.seats, seatCount.get(s.schoolId) ?? 0, elapsedMs, pricing);
          await client.schoolSubscription.update({
            where: { id: s.id },
            data: { arrearsAccruedAt: now, ...(accrued > 0 ? { seatArrearsMinor: { increment: accrued } } : {}) },
          });
          if (accrued > 0) {
            this.logger.log(`seat arrears accrued school=${s.schoolId} +${accrued} minor (${currency})`);
          }
        } catch (e) {
          // NAMED, not counted only. A count says four failed and never which,
          // and the one failing every night is the one worth fixing. The stamp
          // is deliberately NOT advanced, so tomorrow's sweep meters this
          // school's whole window rather than losing it.
          failedSchools.push(s.schoolId);
          this.logger.error(`seat-arrears accrual failed school=${s.schoolId}: ${(e as Error).message}`);
        }
      }
    } catch (e) {
      // The fleet-wide seat query itself. Genuinely fatal for the accrual, so it
      // still aborts — but it is reported as EVERY school failing rather than as
      // a warning nobody reads, because that is what actually happened.
      this.logger.error(`seat-arrears accrual could not start: ${(e as Error).message}`);
      return subs.map((s) => s.schoolId);
    }
    return failedSchools;
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
      seatArrearsMinor: bigint | number;
      // Add-ons renew with the subscription; without this the renewal charged
      // the bare tier and handed the school a free module every period.
      overrides?: unknown;
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
      // Current seats: ON-ROLL students — the SAME definition checkout bills,
      // so a renewal can never charge for a different roster than the quote.
      const seats = Math.max(1, await client.user.count({ where: { schoolId: s.schoolId, ...ON_ROLL_STUDENT } }));
      const pricing = await this.pricing.effective(CURRENCIES.NGN);
      // Outstanding metered seat arrears ride the renewal charge (NGN path).
      const arrearsMinor = Math.max(0, toMinor(s.seatArrearsMinor));
      // Add-ons renew with the subscription. A renewal that quietly dropped
      // them would hand the school a free module every period.
      const overrides = (s.overrides ?? undefined) as ModuleOverrides | undefined;
      const amountMinor = computeSubscriptionPriceMinor(plan, seats, cycle, pricing, overrides) + arrearsMinor;

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
          arrearsMinor,
          initiatedById: admin.userId,
        },
      });
      const charge = await this.paystack.chargeAuthorization({
        email: admin.user.email,
        amountMinor,
        // The same currency the PlatformSubscriptionPayment row above records.
        // A renewal that charges in a different currency from the one it books is
        // a reconciliation problem nobody would find until year end.
        currency: CURRENCIES.NGN,
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
        select: { id: true, name: true, status: true },
      });
      const nameOf = new Map(schools.map((s) => [s.id, s.name]));
      // A SWITCHED-OFF SCHOOL IS STILL LISTED, AND SAID TO BE SWITCHED OFF.
      //
      // The sweep itself skips them — no "renew now" goes to admins who cannot
      // sign in. This digest is the OWNER's own console and hiding a school
      // from it would be worse than listing one: they need to see everything
      // that is not paying. But "12 days past due" beside a school the owner
      // themselves suspended reads as a school to chase, and the action is
      // different — reinstate it, or leave it off deliberately.
      const offOf = new Map(schools.map((s) => [s.id, s.status !== "ACTIVE"]));

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
            }${offOf.get(s.schoolId) ? " — SWITCHED OFF; nobody there is being chased" : ""}`,
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
