// =============================================================================
// DisputesService — gateway chargeback/dispute ingestion, alerts and tracking
// =============================================================================
// Before this, BOTH gateway webhooks silently discarded dispute events — a
// chargeback would only ever be discovered by someone reading a gateway
// dashboard, usually after the evidence deadline had passed. Now both gateways
// feed ONE normalized ingestion path into the tenant-scoped payment_dispute
// table:
//   - Paystack `charge.dispute.create|remind|resolve` (NGN: parent->school
//     invoice charges AND school->platform subscription charges) — tenant from
//     the disputed transaction's own metadata; resolution "declined" => WON.
//   - Stripe `charge.dispute.created|updated|closed` (USD: platform
//     subscription charges) — the event carries only a charge id, so the
//     charge is fetched and its metadata (stamped onto the PaymentIntent at
//     checkout) identifies the school/kind/reference; status "won"/"lost"
//     maps directly.
// Alerts: school finance (accountant/school_admin/principal) on open/remind/
// resolve with the evidence deadline; when the disputed money is PLATFORM
// revenue (metadata.kind === "subscription") the platform owner is alerted
// immediately too — and independently, DISPUTE_ALERT_THRESHOLD disputes per
// school inside DISPUTE_ALERT_WINDOW_DAYS escalates an OPERATOR_ALERT
// (a climbing dispute rate risks gateway suspension of the whole account).
// Staff record their evidence response in-system (respond, fee.manage); the
// actual evidence upload happens on the gateway dashboard — this row is the
// record, deadline tracker and alert anchor. Disputes are financial records:
// the RLS grants no DELETE (rls/78).
// SECURITY: the webhook path resolves the tenant from metadata WE stamped at
// charge init — never from anything the disputing bank controls; an
// unresolvable event is logged and dropped, never guessed.
// =============================================================================

import { BadRequestException, Inject, Injectable, Logger, NotFoundException } from "@nestjs/common";
import { DISPUTE_ALERT_THRESHOLD, DISPUTE_ALERT_WINDOW_DAYS } from "@sms/types";
import type { PaymentDisputeDto } from "@sms/types";
import {
  AUDIT_LOG_SERVICE,
  TENANT_DATABASE,
  type AuditLogService,
  type Principal,
  type TenantContext,
  type TenantDatabase,
  type TenantTx,
} from "../integrity/integrity.foundation";
import { SYSTEM_ACTOR_ID } from "../billing/billing.constants";
import { NotificationService } from "../notifications/notification.service";
import { PrivilegedDatabaseService } from "../common/privileged-database.service";
import type { PaystackEvent } from "../payments/paystack.service";
import { StripeService, type StripeEvent } from "../payments/stripe.service";

/** Roles alerted in-school when a dispute opens/updates/resolves. */
const FINANCE_ROLES = ["accountant", "school_admin", "principal"];

/** One dispute event, gateway-normalized. */
interface NormalizedDispute {
  schoolId: string;
  /** Gateway dispute id — the idempotency/update key. */
  disputeId: string;
  /** Our charge reference (or the gateway charge id when unmapped). */
  reference: string;
  amountMinor: number;
  currency: string;
  category: string | null;
  gatewayStatus: string | null;
  dueAt: Date | null;
  /** Look the reference up in the fees payment ledger (Paystack invoice charges). */
  linkPayment: boolean;
  /** The disputed money is PLATFORM revenue (subscription) — owner alerted on open. */
  platformCharge: boolean;
}

type DisputeRow = {
  id: string;
  gatewayDisputeId: string;
  transactionReference: string;
  paymentId: string | null;
  invoiceId: string | null;
  amountMinor: number;
  currency: string;
  category: string | null;
  status: string;
  gatewayStatus: string | null;
  dueAt: Date | null;
  responseNote: string | null;
  respondedAt: Date | null;
  resolution: string | null;
  resolvedAt: Date | null;
  createdAt: Date;
};

@Injectable()
export class DisputesService {
  private readonly logger = new Logger("Disputes");

  constructor(
    @Inject(TENANT_DATABASE) private readonly db: TenantDatabase,
    @Inject(AUDIT_LOG_SERVICE) private readonly audit: AuditLogService,
    private readonly notifications: NotificationService,
    private readonly privileged: PrivilegedDatabaseService,
    private readonly stripe: StripeService,
  ) {}

  private ctx(p: Principal): TenantContext {
    return { schoolId: p.schoolId, userId: p.userId };
  }

  private toDto(d: DisputeRow): PaymentDisputeDto {
    return {
      id: d.id,
      gatewayDisputeId: d.gatewayDisputeId,
      transactionReference: d.transactionReference,
      paymentId: d.paymentId,
      invoiceId: d.invoiceId,
      amountMinor: d.amountMinor,
      currency: d.currency,
      category: d.category,
      status: d.status as PaymentDisputeDto["status"],
      gatewayStatus: d.gatewayStatus,
      dueAt: d.dueAt,
      responseNote: d.responseNote,
      respondedAt: d.respondedAt,
      resolution: d.resolution,
      resolvedAt: d.resolvedAt,
      createdAt: d.createdAt,
    };
  }

  // ---------------------------------------------------------------------------
  // Paystack ingestion (dispatched by PaymentGatewayService.handleWebhook)
  // ---------------------------------------------------------------------------

  async applyDisputeEvent(event: PaystackEvent): Promise<{ ok: boolean }> {
    const disputeId = event.data.id != null ? String(event.data.id) : null;
    const reference = event.data.transaction?.reference ?? null;
    if (!disputeId || !reference) return { ok: true }; // malformed — nothing to anchor on
    const meta = event.data.transaction?.metadata as { schoolId?: string; kind?: string } | null | undefined;
    const schoolId = await this.resolvePaystackSchoolId(meta, reference);
    if (!schoolId) {
      this.logger.warn(`dispute ${disputeId}: could not resolve a school for reference ${reference} — dropped`);
      return { ok: true };
    }
    const amount = event.data.amount ?? event.data.transaction?.amount ?? 0;
    const n: NormalizedDispute = {
      schoolId,
      disputeId,
      reference,
      amountMinor: typeof amount === "number" && Number.isFinite(amount) ? amount : 0,
      currency: event.data.currency ?? "NGN",
      category: event.data.category ?? null,
      gatewayStatus: event.data.status ?? null,
      dueAt: event.data.due_at ? new Date(event.data.due_at) : null,
      linkPayment: meta?.kind !== "subscription",
      platformCharge: meta?.kind === "subscription",
    };
    if (event.event === "charge.dispute.resolve") {
      // Paystack resolutions: "declined" = the bank REJECTED the dispute (we
      // keep the money — WON); merchant-/auto-accepted = clawed back — LOST.
      const resolution = event.data.resolution ?? null;
      return this.ingestResolution(n, resolution === "declined", resolution);
    }
    return this.ingestOpenOrRefresh(n, { notify: true, remind: event.event === "charge.dispute.remind" });
  }

  /** Our charges always stamp schoolId into the transaction metadata at init;
   *  if the gateway omitted the transaction's metadata, fall back to a
   *  privileged cross-tenant lookup of the payment by its unique reference. */
  private async resolvePaystackSchoolId(
    meta: { schoolId?: string } | null | undefined,
    reference: string,
  ): Promise<string | null> {
    if (meta?.schoolId) return meta.schoolId;
    const client = this.privileged.client;
    if (!client) return null;
    const pay = await client.payment.findFirst({ where: { reference }, select: { schoolId: true } });
    return pay?.schoolId ?? null;
  }

  // ---------------------------------------------------------------------------
  // Stripe ingestion (dispatched by BillingController's stripe webhook)
  // ---------------------------------------------------------------------------

  async applyStripeDisputeEvent(event: StripeEvent): Promise<{ ok: boolean }> {
    const obj = event.data.object;
    const disputeId = obj.id ?? null;
    if (!disputeId) return { ok: true };
    // The dispute event carries only the charge id — the charge's metadata
    // (stamped onto the PaymentIntent at checkout) identifies the school.
    const charge = obj.charge ? await this.stripe.getCharge(obj.charge) : null;
    const meta = { ...(charge?.metadata ?? {}), ...(obj.metadata ?? {}) } as {
      schoolId?: string;
      kind?: string;
      reference?: string;
    };
    if (!meta.schoolId) {
      this.logger.warn(`stripe dispute ${disputeId}: no schoolId metadata on charge ${obj.charge ?? "?"} — dropped`);
      return { ok: true };
    }
    const n: NormalizedDispute = {
      schoolId: meta.schoolId,
      disputeId,
      reference: meta.reference ?? obj.charge ?? disputeId,
      amountMinor: obj.amount ?? charge?.amount ?? 0,
      currency: (obj.currency ?? charge?.currency ?? "usd").toUpperCase(),
      category: obj.reason ?? null,
      gatewayStatus: obj.status ?? null,
      dueAt: obj.evidence_details?.due_by ? new Date(obj.evidence_details.due_by * 1000) : null,
      // Stripe serves platform subscriptions only today; keep it metadata-
      // driven so a future Stripe fees flow inherits the right posture.
      linkPayment: meta.kind !== "subscription",
      platformCharge: meta.kind === "subscription",
    };
    if (event.type === "charge.dispute.closed") {
      return this.ingestResolution(n, obj.status === "won", obj.status ?? null);
    }
    // created -> notify; updated -> refresh silently (Stripe fires updated on
    // every evidence/status touch — re-alerting each one would be noise).
    return this.ingestOpenOrRefresh(n, { notify: event.type === "charge.dispute.created", remind: false });
  }

  // ---------------------------------------------------------------------------
  // Normalized ingestion (shared by both gateways)
  // ---------------------------------------------------------------------------

  private async ingestOpenOrRefresh(
    n: NormalizedDispute,
    opts: { notify: boolean; remind: boolean },
  ): Promise<{ ok: boolean }> {
    const outcome = await this.db.runAsTenant({ schoolId: n.schoolId, userId: SYSTEM_ACTOR_ID }, async (tx) => {
      const payment = n.linkPayment
        ? await tx.payment.findFirst({
            where: { reference: n.reference },
            select: {
              id: true,
              invoiceId: true,
              recordedById: true,
              invoice: { select: { reference: true, createdById: true } },
            },
          })
        : null;
      const existing = await tx.paymentDispute.findFirst({ where: { gatewayDisputeId: n.disputeId } });
      let created = false;
      if (!existing) {
        await tx.paymentDispute.create({
          data: {
            schoolId: n.schoolId,
            gatewayDisputeId: n.disputeId,
            transactionReference: n.reference,
            paymentId: payment?.id ?? null,
            invoiceId: payment?.invoiceId ?? null,
            amountMinor: n.amountMinor,
            currency: n.currency,
            category: n.category,
            gatewayStatus: n.gatewayStatus,
            dueAt: n.dueAt,
          },
        });
        created = true;
      } else {
        // Webhook retry / remind / update: refresh the gateway view of the
        // row — never a second row (gatewayDisputeId is the idempotency key).
        await tx.paymentDispute.update({
          where: { id: existing.id },
          data: { gatewayStatus: n.gatewayStatus ?? existing.gatewayStatus, dueAt: n.dueAt ?? existing.dueAt },
        });
      }
      // Audit needs a REAL user as actor (FK): the disputed payment's recorder,
      // falling back to the invoice's creator. An unmatched reference has
      // neither — the dispute row itself is still the durable record.
      const actorId = payment?.recordedById ?? payment?.invoice?.createdById;
      if (actorId && created) {
        await this.audit.record(
          {
            actorId,
            action: "fee.dispute.opened",
            entity: "payment_dispute",
            entityId: n.disputeId,
            schoolId: n.schoolId,
            metadata: { reference: n.reference, amountMinor: n.amountMinor },
          },
          tx,
        );
      }
      const windowStart = new Date(Date.now() - DISPUTE_ALERT_WINDOW_DAYS * 86_400_000);
      const recentCount = created ? await tx.paymentDispute.count({ where: { createdAt: { gte: windowStart } } }) : 0;
      return {
        created,
        invoiceRef: payment?.invoice?.reference ?? null,
        recipients: await this.financeRecipients(tx),
        recentCount,
      };
    });

    // Alerts AFTER the committed write — a notification failure never loses the
    // dispute record. A retried create (row already there) re-alerts nobody;
    // a remind re-alerts deliberately (the gateway is telling us time is short).
    const notify = (outcome.created && opts.notify) || opts.remind;
    if (notify) {
      const amount = this.formatAmount(n.amountMinor, n.currency);
      const deadline = n.dueAt ? ` Evidence deadline: ${n.dueAt.toISOString().slice(0, 10)}.` : "";
      const what = n.platformCharge
        ? `the school's ${amount} subscription payment`
        : `a ${amount} card payment${outcome.invoiceRef ? ` on invoice ${outcome.invoiceRef}` : ""}`;
      const title = outcome.created
        ? "Chargeback dispute opened — response required"
        : "Chargeback dispute reminder — deadline approaching";
      const body = `The payer's bank is disputing ${what} (ref ${n.reference}).${deadline} Record your response under Fees → Disputes and submit evidence on the gateway dashboard — an unanswered dispute is lost by default.`;
      await this.notifyRecipients(n.schoolId, outcome.recipients, title, body, {
        disputeId: n.disputeId,
        reference: n.reference,
      });
    }
    // Platform revenue disputed: the owner hears about it immediately — this is
    // the platform's money and the platform's merchant account on the line.
    if (outcome.created && n.platformCharge) {
      await this.notifyOwners(
        `Subscription payment disputed (${this.formatAmount(n.amountMinor, n.currency)})`,
        `A school's subscription charge (ref ${n.reference}) is being disputed by their bank.${
          n.dueAt ? ` Evidence deadline: ${n.dueAt.toISOString().slice(0, 10)}.` : ""
        } Respond on the gateway dashboard; review the school's standing in the operator console.`,
        { schoolId: n.schoolId, disputeId: n.disputeId, reference: n.reference },
      );
    }
    if (outcome.created && outcome.recentCount >= DISPUTE_ALERT_THRESHOLD) {
      await this.alertDisputeRate(n.schoolId, outcome.recentCount);
    }
    return { ok: true };
  }

  private async ingestResolution(
    n: NormalizedDispute,
    won: boolean,
    resolution: string | null,
  ): Promise<{ ok: boolean }> {
    const outcome = await this.db.runAsTenant({ schoolId: n.schoolId, userId: SYSTEM_ACTOR_ID }, async (tx) => {
      const existing = await tx.paymentDispute.findFirst({ where: { gatewayDisputeId: n.disputeId } });
      const payment = n.linkPayment
        ? await tx.payment.findFirst({
            where: { reference: n.reference },
            select: {
              id: true,
              invoiceId: true,
              recordedById: true,
              invoice: { select: { reference: true, createdById: true } },
            },
          })
        : null;
      if (existing) {
        await tx.paymentDispute.update({
          where: { id: existing.id },
          data: {
            status: won ? "WON" : "LOST",
            gatewayStatus: n.gatewayStatus ?? existing.gatewayStatus,
            resolution,
            resolvedAt: new Date(),
          },
        });
      } else {
        // Resolve arriving without a create ever landing (e.g. webhook added
        // mid-dispute): record the terminal row anyway — history over silence.
        await tx.paymentDispute.create({
          data: {
            schoolId: n.schoolId,
            gatewayDisputeId: n.disputeId,
            transactionReference: n.reference,
            paymentId: payment?.id ?? null,
            invoiceId: payment?.invoiceId ?? null,
            amountMinor: n.amountMinor,
            currency: n.currency,
            category: n.category,
            status: won ? "WON" : "LOST",
            gatewayStatus: n.gatewayStatus,
            resolution,
            resolvedAt: new Date(),
          },
        });
      }
      const actorId = payment?.recordedById ?? payment?.invoice?.createdById;
      if (actorId) {
        await this.audit.record(
          {
            actorId,
            action: "fee.dispute.resolved",
            entity: "payment_dispute",
            entityId: n.disputeId,
            schoolId: n.schoolId,
            metadata: { reference: n.reference, resolution, won },
          },
          tx,
        );
      }
      return { invoiceRef: payment?.invoice?.reference ?? null, recipients: await this.financeRecipients(tx) };
    });

    const amount = this.formatAmount(n.amountMinor, n.currency);
    const what = n.platformCharge
      ? `the ${amount} subscription payment`
      : `the ${amount} payment${outcome.invoiceRef ? ` (invoice ${outcome.invoiceRef})` : ""}`;
    const title = won ? "Chargeback dispute WON" : "Chargeback dispute LOST — funds clawed back";
    const body = won
      ? `The dispute on ${what} (ref ${n.reference}) was rejected by the bank. The payment stands — no action needed.`
      : n.platformCharge
        ? `The dispute on ${what} (ref ${n.reference}) was resolved against the merchant; the gateway will deduct the amount. The school's subscription standing may need operator review.`
        : `The dispute on ${what} (ref ${n.reference}) was resolved against the school; the gateway will deduct the amount from settlement. Record a refund against the invoice so the ledger matches the money (Fees → invoice → record refund).`;
    await this.notifyRecipients(n.schoolId, outcome.recipients, title, body, {
      disputeId: n.disputeId,
      reference: n.reference,
      won,
    });
    if (n.platformCharge) {
      await this.notifyOwners(`Subscription dispute ${won ? "WON" : "LOST"} (${amount})`, body, {
        schoolId: n.schoolId,
        disputeId: n.disputeId,
        won,
      });
    }
    return { ok: true };
  }

  private async financeRecipients(tx: TenantTx): Promise<string[]> {
    const staff = await tx.userRole.findMany({
      where: { role: { name: { in: FINANCE_ROLES } } },
      select: { userId: true },
      distinct: ["userId"],
    });
    return staff.map((s: { userId: string }) => s.userId);
  }

  private formatAmount(minor: number, currency: string): string {
    try {
      return new Intl.NumberFormat("en-NG", { style: "currency", currency }).format(minor / 100);
    } catch {
      return `${currency} ${(minor / 100).toFixed(2)}`;
    }
  }

  /** Best-effort per recipient — an alert failure never fails the webhook. */
  private async notifyRecipients(
    schoolId: string,
    recipients: string[],
    title: string,
    body: string,
    data: Record<string, unknown>,
  ): Promise<void> {
    for (const recipientId of recipients) {
      try {
        await this.notifications.enqueue(
          { schoolId, userId: recipientId },
          { recipientId, type: "BILLING", title, body, data, channels: ["EMAIL"] },
        );
      } catch {
        // best-effort per recipient
      }
    }
  }

  /** OPERATOR_ALERT to every super_admin (cross-tenant, so it needs the
   *  privileged client — mirrors the dunning digest; silently skipped when
   *  unset). Best-effort: never fails the webhook. */
  private async notifyOwners(title: string, body: string, data: Record<string, unknown>): Promise<void> {
    try {
      const client = this.privileged.client;
      if (!client) return;
      const owners = await client.user.findMany({
        where: { roles: { some: { role: { name: "super_admin" } } } },
        select: { id: true, schoolId: true },
      });
      for (const owner of owners) {
        await this.notifications.enqueue(
          { schoolId: owner.schoolId, userId: owner.id },
          { recipientId: owner.id, type: "OPERATOR_ALERT", title, body, data, channels: ["EMAIL"] },
        );
      }
    } catch (e) {
      this.logger.warn(`operator dispute alert failed: ${(e as Error).message}`);
    }
  }

  /** Dispute-rate threshold escalation (gateway-suspension risk). */
  private async alertDisputeRate(schoolId: string, recentCount: number): Promise<void> {
    const client = this.privileged.client;
    const school = client ? await client.school.findFirst({ where: { id: schoolId }, select: { name: true } }).catch(() => null) : null;
    await this.notifyOwners(
      `Chargeback alert: ${school?.name ?? schoolId} hit ${recentCount} disputes in ${DISPUTE_ALERT_WINDOW_DAYS} days`,
      `${school?.name ?? schoolId} has ${recentCount} payment disputes opened in the last ${DISPUTE_ALERT_WINDOW_DAYS} days (threshold ${DISPUTE_ALERT_THRESHOLD}). A climbing dispute rate risks the gateway suspending the merchant account — review the school's collections.`,
      { schoolId, recentCount },
    );
  }

  // ---------------------------------------------------------------------------
  // Staff surface (fee.manage)
  // ---------------------------------------------------------------------------

  async list(p: Principal): Promise<PaymentDisputeDto[]> {
    return this.db.runAsTenantReadOnly(this.ctx(p), async (tx) => {
      const rows = await tx.paymentDispute.findMany({ orderBy: { createdAt: "desc" }, take: 200 });
      return rows.map((r: DisputeRow) => this.toDto(r));
    });
  }

  async get(p: Principal, id: string): Promise<PaymentDisputeDto> {
    return this.db.runAsTenantReadOnly(this.ctx(p), async (tx) => {
      const row = await tx.paymentDispute.findFirst({ where: { id } });
      if (!row) throw new NotFoundException("Dispute not found"); // 404-not-403 (cross-tenant invisible)
      return this.toDto(row);
    });
  }

  /** Record the school's evidence response (the upload itself happens on the
   *  gateway dashboard — this is the in-system record + status move). */
  async respond(p: Principal, id: string, note: string): Promise<PaymentDisputeDto> {
    return this.db.runAsTenant(this.ctx(p), async (tx) => {
      const row = await tx.paymentDispute.findFirst({ where: { id } });
      if (!row) throw new NotFoundException("Dispute not found");
      if (row.status !== "OPEN") throw new BadRequestException("Only an open dispute can be responded to");
      const updated = await tx.paymentDispute.update({
        where: { id },
        data: { status: "RESPONDED", responseNote: note, respondedById: p.userId, respondedAt: new Date() },
      });
      await this.audit.record(
        {
          actorId: p.userId,
          action: "fee.dispute.respond",
          entity: "payment_dispute",
          entityId: row.gatewayDisputeId,
          schoolId: p.schoolId,
          metadata: { reference: row.transactionReference },
        },
        tx,
      );
      return this.toDto(updated);
    });
  }
}
