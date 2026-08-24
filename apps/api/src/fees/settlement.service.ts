// =============================================================================
// InvoiceSettlementService — the ONE place an online invoice payment posts
// =============================================================================
// Extracted from the Paystack webhook handler so every settlement path shares
// one idempotent implementation: the account webhook, the payer's
// verify-on-return confirm, the reconciliation sweep, and (Stripe) the billing
// webhook's kind=invoice dispatch. Idempotent on the gateway reference — the
// dedup key that makes webhook retries, verify-after-webhook and reconcile-
// after-verify all safe to race. Posts the payment, advances the invoice
// status, audit-logs, receipts payer/guardians/student, and alerts finance on
// overpayment. Lives in its own module (imported by FeesModule and
// BillingModule; imports neither).
// =============================================================================

import { Inject, Injectable, Logger, Optional } from "@nestjs/common";
import { formatMoney } from "@sms/types";
import {
  AUDIT_LOG_SERVICE,
  TENANT_DATABASE,
  type AuditLogService,
  type TenantDatabase,
  type TenantTx,
} from "../integrity/integrity.foundation";
import { SYSTEM_ACTOR_ID } from "../billing/billing.constants";

import { NotificationService } from "../notifications/notification.service";
import { SchoolStatusService } from "../foundation/school-status.service";
import { PrivilegedDatabaseService } from "../common/privileged-database.service";

/** Who is told when money reached a gateway and we declined to post it. Same
 *  set the dispute alerts use — whoever reconciles the bank. */
const FINANCE_ROLES = ["accountant", "school_admin", "principal"];


/**
 * Did this charge land in the PLATFORM's gateway account rather than the
 * school's own bank?
 *
 * True exactly when the school has no settlement subaccount: with nothing to
 * split to, Paystack keeps the whole charge in the main account. The invoice is
 * still correctly PAID — the parent did pay — but the cash is the platform's to
 * release, and until this column existed nothing anywhere recorded that.
 *
 * Read inside the settlement transaction. There is a small window in which a
 * school registers its bank between a charge being initiated and its webhook
 * arriving, and such a payment is recorded as NOT held when it actually was.
 * That is minutes wide, self-correcting (the next charge splits properly), and
 * the alternative — trusting gateway metadata a rail may not echo — fails on
 * the rails that carry no metadata at all, which are the ones most likely to
 * land unsplit.
 */
async function settledToPlatform(tx: TenantTx, schoolId: string): Promise<boolean> {
  const school = await tx.school.findFirst({
    where: { id: schoolId },
    select: { paystackSubaccountCode: true },
  });
  return !school?.paystackSubaccountCode;
}

export interface OnlinePaymentInput {
  schoolId: string;
  invoiceId: string;
  /** The LEDGER credit (invoice amount), in minor units — never the charged
   *  total when a payer-borne convenience fee inflated the charge. */
  creditMinor: number;
  /** What the card was actually charged (for the receipt line). */
  chargedMinor: number;
  /** Gateway reference — THE idempotency key. */
  reference: string;
  /**
   * ISO 4217 the payer was ACTUALLY charged in. Required, and checked against the
   * invoice before anything posts.
   *
   * Not defaulted, ever: the whole class of bug this guards against is a rail
   * quietly using its own currency when nobody named one. A default here would
   * reintroduce it at the last place able to catch it.
   */
  currency: string;
  /** The signed-in user who initiated checkout, when known (gets the receipt). */
  payerId?: string;
  platformFeeMinor?: number;
  /** Free-text method note (e.g. 'Online (Paystack)'). */
  note: string;
  /** Ledger method — CARD for checkout charges (default), BANK_TRANSFER for
   *  dedicated-account (virtual NUBAN) credits. */
  method?: "CARD" | "BANK_TRANSFER";
}

export type SettlementOutcome =
  | "posted"
  | "duplicate"
  | "invoice_missing"
  | "currency_mismatch"
  | "invoice_not_open"
  | "school_disabled";

@Injectable()
export class InvoiceSettlementService {
  private readonly logger = new Logger("Settlement");
  constructor(
    @Inject(TENANT_DATABASE) private readonly db: TenantDatabase,
    @Inject(AUDIT_LOG_SERVICE) private readonly audit: AuditLogService,
    private readonly notifications: NotificationService,
    private readonly schoolStatus: SchoolStatusService,
    @Optional() private readonly privileged?: PrivilegedDatabaseService,
  ) {}

  /**
   * Tell the platform owner that money arrived for a school that is switched
   * off. Best-effort, and deliberately not fatal: failing to send the alert
   * must not turn into a non-2xx that makes the rail retry for days.
   *
   * The alert is the ONLY thing standing between the payer and a silent loss,
   * because nothing else revisits this. It names the reference, so whoever
   * picks it up can find the charge on the gateway without guessing.
   */
  private async alertOwnersOfMoneyForADisabledSchool(input: OnlinePaymentInput): Promise<void> {
    try {
      const client = this.privileged?.client;
      if (!client) return;
      const [school, owners] = await Promise.all([
        client.school.findFirst({ where: { id: input.schoolId }, select: { name: true, status: true } }),
        client.user.findMany({
          where: { roles: { some: { role: { name: "super_admin" } } } },
          select: { id: true, schoolId: true },
        }),
      ]);
      const name = school?.name ?? input.schoolId;
      const title = `Payment received for ${name}, which is switched off`;
      const body =
        `${formatMoney(input.creditMinor, input.currency)} was charged (reference ${input.reference}) against an ` +
        `invoice at ${name}. The school's status is ${school?.status ?? "not ACTIVE"}, so nothing was posted to its ` +
        `ledger and no receipt was sent. The payer HAS been debited. Either reinstate the school — which restores it ` +
        `to its original and due state and lets the reconciliation sweep post this — or refund the payment on the ` +
        `gateway.`;
      for (const owner of owners) {
        await this.notifications.enqueue(
          { schoolId: owner.schoolId, userId: owner.id },
          {
            recipientId: owner.id,
            type: "OPERATOR_ALERT",
            title,
            body,
            data: { schoolId: input.schoolId, reference: input.reference, creditMinor: input.creditMinor, currency: input.currency },
            channels: ["EMAIL"],
          },
        );
      }
    } catch (e) {
      this.logger.warn(`disabled-school settlement alert failed: ${(e as Error).message}`);
    }
  }

  async applyOnlinePayment(input: OnlinePaymentInput): Promise<SettlementOutcome> {
    const { schoolId, invoiceId } = input;
    // A SWITCHED-OFF SCHOOL RECEIVES NOTHING.
    //
    // DISABLED means the school reaches nothing and nobody at it can sign in.
    // Money kept arriving anyway: a checkout opened before the switch was
    // thrown still calls back, and a dedicated NUBAN transfer needs no session
    // at all — a parent can pay into it at any hour. Every one of those posted
    // to a ledger nobody could open, against an invoice nobody could see, and
    // sent a receipt in the name of a school that could not answer the phone.
    //
    // Checked HERE because this is the one posting path: card, mobile money,
    // virtual account, both verify-on-return routes and the reconciliation
    // sweep all come through it, so one guard closes every rail including the
    // ones not written yet — the same argument the currency check below makes.
    //
    // It does NOT change the HTTP answer. A callback still gets 2xx; a
    // non-2xx makes a rail retry for days, and retrying will not make the
    // school active. Refusing to POST is the whole of the refusal.
    if (!(await this.schoolStatus.isActive(schoolId))) {
      // THE MONEY HAS ALREADY MOVED, so this cannot be silent. The payer has
      // been debited and the platform is now holding funds for a school that
      // is switched off; only a person can decide between reinstating the
      // school and refunding the payer. There is no sweep that will do it —
      // the reconciliation sweep looks back three days and a suspension lasts
      // as long as it lasts.
      this.logger.error(
        `settlement refused: school ${schoolId} is not ACTIVE — ${input.currency} ${input.creditMinor} ` +
          `(ref ${input.reference}) was charged and has NOT been posted to invoice ${invoiceId}. ` +
          `Reinstate the school or refund the payer.`,
      );
      await this.alertOwnersOfMoneyForADisabledSchool(input);
      return "school_disabled" as const;
    }
    // System-context write (no user): the audit actor is the invoice's creator.
    const receipt = await this.db.runAsTenant({ schoolId, userId: SYSTEM_ACTOR_ID }, async (tx) => {
      const inv = await tx.invoice.findFirst({ where: { id: invoiceId } });
      if (!inv) return "invoice_missing" as const;

      // CURRENCY MUST MATCH, and this is the ONE place that can enforce it for
      // every rail at once — card, mobile money, virtual account, verify-on-return
      // and the reconciliation sweep all post through here.
      //
      // A charge in one currency credited against an invoice in another is not an
      // approximation, it is a wrong number: NGN 5,000 against a GHS 5,000 invoice
      // marked it PAID while the school received about a tenth. Refusing leaves the
      // invoice OPEN and the payment unposted, which is recoverable — posting it
      // silently is not, because nothing downstream ever revisits a settled invoice.
      if (inv.currency !== input.currency) return "currency_mismatch" as const;
      // AND THE INVOICE MUST STILL BE OPEN.
      //
      // Look at what this method does with `status` at the end: it computes one
      // from the payments and WRITES IT OVER whatever the invoice had. So
      // settling a charge onto a CANCELLED invoice does not merely record money
      // in an odd place — it RESURRECTS the invoice as PARTIALLY_PAID or PAID,
      // silently undoing a cancellation the school made deliberately.
      //
      // The route is ordinary, not exotic: a parent opens a checkout while the
      // invoice is ISSUED, the school then cancels it (wrong amount, duplicate
      // bill, the pupil left), and the parent completes payment on the page
      // still open in front of them. #255 stopped a checkout being STARTED
      // against a cancelled invoice; it cannot stop one already in flight.
      //
      // Refused rather than posted, for the reason the currency check gives
      // just above: refusing leaves the money unposted and recoverable by hand,
      // while posting is not, because nothing downstream revisits a settled
      // invoice. A DRAFT is refused for the same reason it can never be
      // charged in the first place — it is not a bill yet.
      if (inv.status !== "ISSUED" && inv.status !== "PARTIALLY_PAID") {
        return { kind: "invoice_not_open" as const, status: inv.status };
      }
      // IDEMPOTENCY: the gateway RETRIES a webhook on any non-2xx / timeout
      // (and can double-deliver), and verify-on-return / reconciliation can
      // race the webhook. Without this guard each path would insert ANOTHER
      // POSTED payment for the same charge and double-credit the invoice.
      const already = await tx.payment.findFirst({
        where: { invoiceId, reference: input.reference },
        select: { id: true },
      });
      if (already) return "duplicate" as const;
      await tx.payment.create({
        data: {
          schoolId,
          invoiceId,
          amountMinor: input.creditMinor,
          method: input.method ?? "CARD",
          kind: "PAYMENT",
          status: "POSTED",
          reference: input.reference,
          platformFeeMinor: input.platformFeeMinor ?? 0,
          // Snapshot of WHERE this money landed. When the school has no
          // settlement subaccount the split has nowhere to go and the whole
          // charge sits in the platform's gateway balance — a debt, which
          // nothing recorded before this column existed. Read here rather than
          // derived later, because derived from current state it would silently
          // stop being owed the day the school registers a bank.
          settledToPlatform: await settledToPlatform(tx, schoolId),
          note: input.note,
          recordedById: inv.createdById,
        },
      });
      const posted = await tx.payment.findMany({
        where: { invoiceId, status: "POSTED" },
        select: { amountMinor: true, kind: true },
      });
      const paid = posted.reduce(
        (n: number, x: { amountMinor: number; kind: string }) => n + (x.kind === "REFUND" ? -x.amountMinor : x.amountMinor),
        0,
      );
      const status = paid >= inv.totalMinor ? "PAID" : paid > 0 ? "PARTIALLY_PAID" : "ISSUED";
      await tx.invoice.update({ where: { id: invoiceId }, data: { status } });
      await this.audit.record(
        {
          actorId: inv.createdById,
          action: "fee.payment.online",
          entity: "invoice",
          entityId: invoiceId,
          schoolId,
          metadata: { reference: input.reference },
        },
        tx,
      );
      const guardians = await tx.parentChild.findMany({
        where: { studentId: inv.studentId },
        select: { parentId: true },
      });
      // OVERPAYMENT detection: two guardians can legitimately race to pay the
      // same invoice — both charges succeed at the gateway. The ledger records
      // it honestly; finance must be TOLD so the excess is refunded promptly.
      let financeRecipients: string[] = [];
      if (paid > inv.totalMinor) {
        const finance = await tx.userRole.findMany({
          where: { role: { name: { in: ["accountant", "school_admin"] } } },
          select: { userId: true },
          distinct: ["userId"],
        });
        financeRecipients = [...new Set([...finance.map((f: { userId: string }) => f.userId), inv.createdById])];
      }
      return {
        invoiceRef: inv.reference,
        currency: inv.currency,
        balanceAfter: inv.totalMinor - paid,
        overpaidMinor: Math.max(0, paid - inv.totalMinor),
        financeRecipients,
        recipients: [
          ...new Set([
            ...guardians.map((g: { parentId: string }) => g.parentId),
            inv.studentId,
            ...(input.payerId ? [input.payerId] : []),
          ]),
        ],
      };
    });

    if (receipt === "invoice_missing") return "invoice_missing";
    if (receipt === "duplicate") return "duplicate";
    if (receipt === "currency_mismatch") {
      await this.refuse(
        input,
        `charge in ${input.currency} against invoice ${input.invoiceId} — currency mismatch`,
        "A payment could not be applied (currency mismatch)",
      );
      return "currency_mismatch";
    }
    if (typeof receipt === "object" && "kind" in receipt && receipt.kind === "invoice_not_open") {
      await this.refuse(
        input,
        `invoice ${input.invoiceId} is ${String(receipt.status)}, not open for payment`,
        // Defensive `String(...)`: this path must never be the thing that
        // THROWS. A settlement that crashes leaves the gateway retrying and
        // nobody told, which is strictly worse than the refusal it was trying
        // to report.
        `A payment arrived for an invoice that is ${String(receipt.status ?? "not open").toLowerCase()}`,
      );
      return "invoice_not_open";
    }

    // Receipt AFTER the committed write — a notification failure never undoes
    // a recorded payment. Every online payment gets one, partial or full.
    // formatMoney asks the CURRENCY how many decimals it has. The old
    // `minor / 100` under a hard-coded en-NG printed a CFA-franc receipt at a
    // HUNDREDTH of its value — the same divide-by-100 bug the currency work
    // removed platform-wide, still live on the one path every payer sees.
    const fmt = (minor: number) => formatMoney(minor, receipt.currency);
    const balanceLine =
      receipt.balanceAfter <= 0
        ? "The invoice is now fully paid. Thank you."
        : `Outstanding balance: ${fmt(receipt.balanceAfter)}.`;
    for (const recipientId of receipt.recipients) {
      try {
        await this.notifications.enqueue(
          { schoolId, userId: recipientId },
          {
            recipientId,
            type: "PAYMENT_RECEIVED",
            title: "Payment receipt — successful",
            body: `We received ${fmt(input.chargedMinor)} by card on invoice ${receipt.invoiceRef} (ref ${input.reference}). ${balanceLine}`,
            data: { invoiceId, reference: input.reference, amountMinor: input.chargedMinor },
            channels: ["EMAIL"],
          },
        );
      } catch {
        // best-effort per recipient
      }
    }
    if (receipt.overpaidMinor > 0) {
      for (const recipientId of receipt.financeRecipients) {
        try {
          await this.notifications.enqueue(
            { schoolId, userId: recipientId },
            {
              recipientId,
              type: "BILLING",
              title: "Overpayment on an invoice — refund due",
              body: `Invoice ${receipt.invoiceRef} is overpaid by ${fmt(receipt.overpaidMinor)} (likely two payers paying at once, ref ${input.reference}). Record a refund of the excess from the invoice page.`,
              data: { invoiceId, overpaidMinor: receipt.overpaidMinor },
              channels: ["EMAIL"],
            },
          );
        } catch {
          // best-effort per recipient
        }
      }
    }
    return "posted";
  }

  /**
   * A settlement we are declining to post.
   *
   * Money reached a gateway and is not going onto the ledger, so somebody has
   * to reconcile it by hand — refund the payer, or re-issue the bill and take
   * it again. That was a `logger.error` and nothing else, which is the failure
   * this codebase keeps finding: recorded faithfully somewhere nobody reads.
   * Finance is TOLD, by name, on the same day.
   *
   * The alert says what arrived and what to do; it deliberately does not say
   * the payer is out of pocket in so many words, because whether they are
   * depends on the rail and finance is the one who can look.
   */
  private async refuse(input: OnlinePaymentInput, why: string, title: string): Promise<void> {
    this.logger.error(`settlement REFUSED ${input.reference}: ${why}. Payment NOT posted.`);
    try {
      // WHO to tell is a read; TELLING them is not. Enqueuing inside the
      // transaction held it open for one round-trip per recipient and nested a
      // second transaction inside it — each enqueue opens its own — for no
      // benefit, since a notification commits separately and cannot be rolled
      // back with this one anyway.
      const staff = (await this.db.runAsTenantReadOnly(
        { schoolId: input.schoolId, userId: SYSTEM_ACTOR_ID },
        (tx) =>
          tx.userRole.findMany({
            where: { role: { name: { in: FINANCE_ROLES } } },
            select: { userId: true },
            distinct: ["userId"],
          }),
      )) as Array<{ userId: string }>;
      for (const s of staff) {
        await this.notifications.enqueue(
          { schoolId: input.schoolId, userId: SYSTEM_ACTOR_ID },
          {
            recipientId: s.userId,
            type: "OPERATOR_ALERT",
            title,
            body: `Reference ${input.reference}: ${why}. The payment was NOT recorded — check the gateway and either refund it or re-issue the bill.`,
            data: { invoiceId: input.invoiceId, reference: input.reference },
          },
        );
      }
    } catch (e) {
      // An alert that fails must not turn a refusal into a crash — the log line
      // above is still the record of last resort.
      this.logger.error(`could not alert finance about ${input.reference}: ${String(e).slice(0, 120)}`);
    }
  }

}
