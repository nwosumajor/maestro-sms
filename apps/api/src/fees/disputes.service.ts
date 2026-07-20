// =============================================================================
// DisputesService — gateway chargeback/dispute ingestion, alerts and tracking
// =============================================================================
// Before this, the account-wide Paystack webhook silently discarded every
// charge.dispute.* event — a chargeback would only ever be discovered by
// someone reading the gateway dashboard, usually after the evidence deadline
// had passed. Now:
//   - charge.dispute.create  -> a tenant-scoped payment_dispute row linked to
//     the disputed payment/invoice + an immediate finance alert (deadline in
//     the body). Idempotent on the gateway dispute id (webhook retries).
//   - charge.dispute.remind  -> deadline refreshed + finance re-alerted.
//   - charge.dispute.resolve -> WON ("declined": the bank rejected the
//     dispute) or LOST (merchant-accepted / auto-accepted: the gateway claws
//     the money back) + finance told what to do next.
//   - THRESHOLD ESCALATION: >= DISPUTE_ALERT_THRESHOLD disputes against one
//     school inside DISPUTE_ALERT_WINDOW_DAYS raises an OPERATOR_ALERT to the
//     platform owner — a climbing dispute rate risks Paystack suspending the
//     whole merchant account, which is a platform problem, not a school one.
// Staff record their evidence response in-system (respond, fee.manage); the
// actual evidence upload happens on the gateway dashboard — this row is the
// record, deadline tracker and alert anchor. Disputes are financial records:
// the RLS grants no DELETE (rls/78).
// SECURITY: the webhook path resolves the tenant from the charge's OWN
// metadata (stamped by us at init) — never from anything the disputing bank
// controls; an unresolvable event is logged and dropped, never guessed.
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

/** Roles alerted in-school when a dispute opens/updates/resolves. */
const FINANCE_ROLES = ["accountant", "school_admin", "principal"];

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
  // Webhook ingestion (system context — dispatched by PaymentGatewayService)
  // ---------------------------------------------------------------------------

  async applyDisputeEvent(event: PaystackEvent): Promise<{ ok: boolean }> {
    const disputeId = event.data.id != null ? String(event.data.id) : null;
    const reference = event.data.transaction?.reference ?? null;
    if (!disputeId || !reference) return { ok: true }; // malformed — nothing to anchor on
    const schoolId = await this.resolveSchoolId(event, reference);
    if (!schoolId) {
      this.logger.warn(`dispute ${disputeId}: could not resolve a school for reference ${reference} — dropped`);
      return { ok: true };
    }
    if (event.event === "charge.dispute.resolve") return this.applyResolution(event, schoolId, disputeId, reference);
    return this.applyOpenOrRemind(event, schoolId, disputeId, reference);
  }

  /** Our charges always stamp schoolId into the transaction metadata at init;
   *  if the gateway omitted the transaction's metadata, fall back to a
   *  privileged cross-tenant lookup of the payment by its unique reference. */
  private async resolveSchoolId(event: PaystackEvent, reference: string): Promise<string | null> {
    const meta = event.data.transaction?.metadata as { schoolId?: string } | null | undefined;
    if (meta?.schoolId) return meta.schoolId;
    const client = this.privileged.client;
    if (!client) return null;
    const pay = await client.payment.findFirst({ where: { reference }, select: { schoolId: true } });
    return pay?.schoolId ?? null;
  }

  private disputedAmountMinor(event: PaystackEvent): number {
    const amount = event.data.amount ?? event.data.transaction?.amount ?? 0;
    return typeof amount === "number" && Number.isFinite(amount) ? amount : 0;
  }

  private async applyOpenOrRemind(
    event: PaystackEvent,
    schoolId: string,
    disputeId: string,
    reference: string,
  ): Promise<{ ok: boolean }> {
    const dueAt = event.data.due_at ? new Date(event.data.due_at) : null;
    const outcome = await this.db.runAsTenant({ schoolId, userId: SYSTEM_ACTOR_ID }, async (tx) => {
      const payment = await tx.payment.findFirst({
        where: { reference },
        select: {
          id: true,
          invoiceId: true,
          recordedById: true,
          invoice: { select: { reference: true, createdById: true } },
        },
      });
      const existing = await tx.paymentDispute.findFirst({ where: { gatewayDisputeId: disputeId } });
      let created = false;
      if (!existing) {
        await tx.paymentDispute.create({
          data: {
            schoolId,
            gatewayDisputeId: disputeId,
            transactionReference: reference,
            paymentId: payment?.id ?? null,
            invoiceId: payment?.invoiceId ?? null,
            amountMinor: this.disputedAmountMinor(event),
            currency: event.data.currency ?? "NGN",
            category: event.data.category ?? null,
            gatewayStatus: event.data.status ?? null,
            dueAt,
          },
        });
        created = true;
      } else {
        // Webhook retry of create, or a remind: refresh the gateway view of the
        // row — never a second row (gatewayDisputeId is the idempotency key).
        await tx.paymentDispute.update({
          where: { id: existing.id },
          data: { gatewayStatus: event.data.status ?? existing.gatewayStatus, dueAt: dueAt ?? existing.dueAt },
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
            entityId: disputeId,
            schoolId,
            metadata: { reference, amountMinor: this.disputedAmountMinor(event) },
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
    const notify = outcome.created || event.event === "charge.dispute.remind";
    if (notify) {
      const amount = this.formatAmount(this.disputedAmountMinor(event), event.data.currency ?? "NGN");
      const deadline = dueAt ? ` Evidence deadline: ${dueAt.toISOString().slice(0, 10)}.` : "";
      const title = outcome.created
        ? "Chargeback dispute opened — response required"
        : "Chargeback dispute reminder — deadline approaching";
      const body = `A ${amount} card payment${outcome.invoiceRef ? ` on invoice ${outcome.invoiceRef}` : ""} (ref ${reference}) is being disputed by the payer's bank.${deadline} Record your response under Fees → Disputes and submit evidence on the Paystack dashboard — an unanswered dispute is lost by default.`;
      await this.notifyRecipients(schoolId, outcome.recipients, title, body, { disputeId, reference });
    }
    if (outcome.created && outcome.recentCount >= DISPUTE_ALERT_THRESHOLD) {
      await this.alertOperators(schoolId, outcome.recentCount);
    }
    return { ok: true };
  }

  private async applyResolution(
    event: PaystackEvent,
    schoolId: string,
    disputeId: string,
    reference: string,
  ): Promise<{ ok: boolean }> {
    // Paystack resolutions: "declined" = the bank REJECTED the dispute (we keep
    // the money — WON); "merchant-accepted" / "auto-accepted" (no response in
    // time) = the charge is clawed back — LOST.
    const resolution = event.data.resolution ?? null;
    const won = resolution === "declined";
    const outcome = await this.db.runAsTenant({ schoolId, userId: SYSTEM_ACTOR_ID }, async (tx) => {
      const existing = await tx.paymentDispute.findFirst({ where: { gatewayDisputeId: disputeId } });
      const payment = await tx.payment.findFirst({
        where: { reference },
        select: { id: true, invoiceId: true, recordedById: true, invoice: { select: { reference: true, createdById: true } } },
      });
      if (existing) {
        await tx.paymentDispute.update({
          where: { id: existing.id },
          data: {
            status: won ? "WON" : "LOST",
            gatewayStatus: event.data.status ?? existing.gatewayStatus,
            resolution,
            resolvedAt: new Date(),
          },
        });
      } else {
        // Resolve arriving without a create ever landing (e.g. webhook added
        // mid-dispute): record the terminal row anyway — history over silence.
        await tx.paymentDispute.create({
          data: {
            schoolId,
            gatewayDisputeId: disputeId,
            transactionReference: reference,
            paymentId: payment?.id ?? null,
            invoiceId: payment?.invoiceId ?? null,
            amountMinor: this.disputedAmountMinor(event),
            currency: event.data.currency ?? "NGN",
            category: event.data.category ?? null,
            status: won ? "WON" : "LOST",
            gatewayStatus: event.data.status ?? null,
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
            entityId: disputeId,
            schoolId,
            metadata: { reference, resolution, won },
          },
          tx,
        );
      }
      return { invoiceRef: payment?.invoice?.reference ?? null, recipients: await this.financeRecipients(tx) };
    });

    const amount = this.formatAmount(this.disputedAmountMinor(event), event.data.currency ?? "NGN");
    const title = won ? "Chargeback dispute WON" : "Chargeback dispute LOST — funds clawed back";
    const body = won
      ? `The dispute on the ${amount} payment${outcome.invoiceRef ? ` (invoice ${outcome.invoiceRef})` : ""} (ref ${reference}) was declined by the bank. The payment stands — no action needed.`
      : `The dispute on the ${amount} payment${outcome.invoiceRef ? ` (invoice ${outcome.invoiceRef})` : ""} (ref ${reference}) was resolved against the school; the gateway will deduct the amount from settlement. Record a refund against the invoice so the ledger matches the money (Fees → invoice → record refund).`;
    await this.notifyRecipients(schoolId, outcome.recipients, title, body, { disputeId, reference, won });
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
    return new Intl.NumberFormat("en-NG", { style: "currency", currency }).format(minor / 100);
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

  /** Dispute-rate threshold alert to the platform owner (cross-tenant, so it
   *  needs the privileged client — mirrors the dunning digest; silently skipped
   *  when unset). Best-effort: never fails the webhook. */
  private async alertOperators(schoolId: string, recentCount: number): Promise<void> {
    try {
      const client = this.privileged.client;
      if (!client) return;
      const school = await client.school.findFirst({ where: { id: schoolId }, select: { name: true } });
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
            title: `Chargeback alert: ${school?.name ?? schoolId} hit ${recentCount} disputes in ${DISPUTE_ALERT_WINDOW_DAYS} days`,
            body: `${school?.name ?? schoolId} has ${recentCount} payment disputes opened in the last ${DISPUTE_ALERT_WINDOW_DAYS} days (threshold ${DISPUTE_ALERT_THRESHOLD}). A climbing dispute rate risks the gateway suspending the merchant account — review the school's collections.`,
            data: { schoolId, recentCount },
            channels: ["EMAIL"],
          },
        );
      }
    } catch (e) {
      this.logger.warn(`operator dispute alert failed for school ${schoolId}: ${(e as Error).message}`);
    }
  }

  // ---------------------------------------------------------------------------
  // Staff surface (fee.read / fee.manage)
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
