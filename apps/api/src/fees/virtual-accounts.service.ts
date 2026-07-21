// =============================================================================
// VirtualAccountsService — per-student dedicated NUBAN (bank-transfer fees)
// =============================================================================
// Bank transfer dominates Nigerian school-fee payment, and until now every
// transfer had to be hand-recorded by staff. A staff member provisions ONE
// Paystack dedicated account per student (gateway customer + NUBAN, stored in
// student_virtual_account); parents then pay by ordinary transfer and the
// gateway's charge.success webhook — which for dedicated accounts carries NO
// metadata, only the customer code — is mapped back here (privileged
// code->student lookup, the same cross-tenant posture as every webhook
// resolver) and credited to the student's OLDEST open invoice through the
// shared idempotent settlement path. A transfer with no open invoice alerts
// finance instead of guessing. Guardians are told the account details on
// provisioning. 503-disabled without gateway creds.
// =============================================================================

import { Inject, Injectable, Logger, NotFoundException, ServiceUnavailableException } from "@nestjs/common";
import type { VirtualAccountDto } from "@sms/types";
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
import { PaystackService, type PaystackEvent } from "../payments/paystack.service";
import { InvoiceSettlementService } from "./settlement.service";

type VaRow = {
  id: string;
  studentId: string;
  accountNumber: string;
  bankName: string;
  active: boolean;
  createdAt: Date;
};

@Injectable()
export class VirtualAccountsService {
  private readonly logger = new Logger("VirtualAccounts");

  constructor(
    @Inject(TENANT_DATABASE) private readonly db: TenantDatabase,
    @Inject(AUDIT_LOG_SERVICE) private readonly audit: AuditLogService,
    private readonly paystack: PaystackService,
    private readonly privileged: PrivilegedDatabaseService,
    private readonly notifications: NotificationService,
    private readonly settlement: InvoiceSettlementService,
  ) {}

  private ctx(p: Principal): TenantContext {
    return { schoolId: p.schoolId, userId: p.userId };
  }

  private toDto(v: VaRow): VirtualAccountDto {
    return {
      studentId: v.studentId,
      accountNumber: v.accountNumber,
      bankName: v.bankName,
      active: v.active,
      createdAt: v.createdAt,
    };
  }

  /** Staff provisions a student's dedicated account (idempotent: an existing
   *  row is returned, never a second NUBAN). */
  async provision(p: Principal, studentId: string): Promise<VirtualAccountDto> {
    if (!this.paystack.isConfigured()) {
      throw new ServiceUnavailableException("Online payments are not configured");
    }
    const pre = await this.db.runAsTenant(this.ctx(p), async (tx) => {
      const student = await tx.user.findFirst({ where: { id: studentId }, select: { name: true, email: true } });
      if (!student) throw new NotFoundException("Student not found");
      const existing = await tx.studentVirtualAccount.findFirst({ where: { studentId } });
      return { student, existing };
    });
    if (pre.existing) return this.toDto(pre.existing as VaRow);

    const [firstName, ...rest] = pre.student.name.split(" ");
    const { customerCode } = await this.paystack.createCustomer({
      email: pre.student.email,
      firstName: firstName || "Student",
      lastName: rest.join(" ") || "Account",
    });
    const { accountNumber, bankName } = await this.paystack.createDedicatedAccount(customerCode);

    const created = await this.db.runAsTenant(this.ctx(p), async (tx) => {
      const row = await tx.studentVirtualAccount.create({
        data: { schoolId: p.schoolId, studentId, customerCode, accountNumber, bankName },
      });
      await this.audit.record(
        {
          actorId: p.userId,
          action: "fee.virtual_account.provision",
          entity: "student_virtual_account",
          entityId: row.id,
          schoolId: p.schoolId,
          metadata: { studentId, accountLast4: accountNumber.slice(-4), bankName },
        },
        tx,
      );
      const guardians = await tx.parentChild.findMany({ where: { studentId }, select: { parentId: true } });
      return { row, recipients: [...new Set([...guardians.map((g: { parentId: string }) => g.parentId), studentId])] };
    });

    for (const recipientId of created.recipients) {
      try {
        await this.notifications.enqueue(this.ctx(p), {
          recipientId,
          type: "BILLING",
          title: "Dedicated fee account assigned",
          body: `School fees for ${pre.student.name} can now be paid by bank transfer to ${accountNumber} (${bankName}). Transfers credit the oldest unpaid invoice automatically.`,
          data: { studentId },
          channels: ["EMAIL"],
        });
      } catch {
        // best-effort per recipient
      }
    }
    return this.toDto(created.row as VaRow);
  }

  /** Self / guardian / staff read — 404-not-403 for everyone else. */
  async getForStudent(p: Principal, studentId: string): Promise<VirtualAccountDto> {
    return this.db.runAsTenantReadOnly(this.ctx(p), async (tx) => {
      if (!(await this.canSee(tx, p, studentId))) throw new NotFoundException("Not found");
      const row = await tx.studentVirtualAccount.findFirst({ where: { studentId } });
      if (!row) throw new NotFoundException("Not found");
      return this.toDto(row as VaRow);
    });
  }

  private async canSee(tx: TenantTx, p: Principal, studentId: string): Promise<boolean> {
    if (p.userId === studentId) return true;
    const link = await tx.parentChild.findFirst({ where: { parentId: p.userId, studentId }, select: { id: true } });
    if (link) return true;
    return p.roles.some((r) => ["accountant", "school_admin", "principal", "teacher", "super_admin"].includes(r));
  }

  /**
   * Webhook path: a charge.success with channel dedicated_nuban / no metadata.
   * Map customer code -> student (privileged), credit the OLDEST open invoice.
   */
  async applyDedicatedCredit(event: PaystackEvent): Promise<{ ok: boolean }> {
    const code = event.data.customer?.customer_code;
    if (!code) return { ok: true };
    const client = this.privileged.client;
    if (!client) {
      this.logger.warn(`dedicated credit ${event.data.reference}: privileged client unavailable — event logged only`);
      return { ok: true };
    }
    const va = await client.studentVirtualAccount.findFirst({
      where: { customerCode: code },
      select: { schoolId: true, studentId: true, active: true },
    });
    if (!va) {
      this.logger.warn(`dedicated credit ${event.data.reference}: unknown customer ${code} — dropped`);
      return { ok: true };
    }
    const target = await this.db.runAsTenant({ schoolId: va.schoolId, userId: SYSTEM_ACTOR_ID }, async (tx) => {
      const inv = await tx.invoice.findFirst({
        where: { studentId: va.studentId, status: { in: ["ISSUED", "PARTIALLY_PAID"] } },
        orderBy: [{ dueDate: "asc" }, { createdAt: "asc" }],
        select: { id: true, createdById: true },
      });
      if (inv) return { invoiceId: inv.id, finance: [] as string[] };
      const finance = await tx.userRole.findMany({
        where: { role: { name: { in: ["accountant", "school_admin"] } } },
        select: { userId: true },
        distinct: ["userId"],
      });
      return { invoiceId: null, finance: finance.map((f: { userId: string }) => f.userId) };
    });

    if (target.invoiceId) {
      await this.settlement.applyOnlinePayment({
        schoolId: va.schoolId,
        invoiceId: target.invoiceId,
        creditMinor: event.data.amount,
        chargedMinor: event.data.amount,
        reference: event.data.reference,
        note: "Bank transfer (dedicated account)",
        method: "BANK_TRANSFER",
      });
      return { ok: true };
    }
    // No open invoice: don't guess — tell finance (the gateway_event row and
    // the gateway dashboard hold the money trail).
    const amount = new Intl.NumberFormat("en-NG", { style: "currency", currency: "NGN" }).format(event.data.amount / 100);
    for (const recipientId of target.finance) {
      try {
        await this.notifications.enqueue(
          { schoolId: va.schoolId, userId: recipientId },
          {
            recipientId,
            type: "BILLING",
            title: "Bank transfer received — no open invoice",
            body: `${amount} arrived on a student's dedicated account (ref ${event.data.reference}) but they have no open invoice. Issue an invoice and record the payment against it, or arrange a refund.`,
            data: { studentId: va.studentId, reference: event.data.reference, amountMinor: event.data.amount },
            channels: ["EMAIL"],
          },
        );
      } catch {
        // best-effort per recipient
      }
    }
    return { ok: true };
  }
}

// Narrow re-export so PaymentGatewayService can gate dispatch without
// re-deriving the rule: a dedicated-account credit is a charge.success with no
// metadata kind and a customer code.
export function isDedicatedAccountCredit(event: PaystackEvent): boolean {
  const kind = (event.data.metadata as { kind?: string } | undefined)?.kind;
  return !kind && (event.data.channel === "dedicated_nuban" || !!event.data.customer?.customer_code);
}
