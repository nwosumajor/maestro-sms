import { Body, Controller, Get, Headers, Param, Patch, Post, Query, Req } from "@nestjs/common";
import { MODULES } from "@sms/types";
import { RequireModule } from "../auth/require-module.decorator";
import type { RawBodyRequest } from "@nestjs/common";
import type { Request } from "express";
import { z } from "zod";
import { FEES_PERMISSIONS, INVOICE_STATUSES, PAYMENT_METHODS } from "@sms/types";
import type {
  FeeItemDto,
  FeeReportDto,
  InvoiceListItemDto,
  InvoiceDetailDto,
  PendingPaymentDto,
} from "@sms/types";
import { RequirePermission } from "../auth/require-permission.decorator";
import { Public } from "../auth/public.decorator";
import { CurrentPrincipal } from "../auth/current-principal.decorator";
import { ZodValidationPipe } from "../common/zod-validation.pipe";
import type { Principal } from "../integrity/integrity.foundation";
import { FeesService } from "./fees.service";
import { PaymentGatewayService } from "./payment-gateway.service";

const minor = z.number().int().min(0);
const feeItemSchema = z.object({
  name: z.string().min(1).max(200),
  description: z.string().max(2000).nullish(),
  amountMinor: minor,
  currency: z.string().length(3).optional(),
  active: z.boolean().optional(),
});
const feeItemUpdateSchema = feeItemSchema.partial();
const invoiceSchema = z.object({
  studentId: z.string().uuid(),
  dueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  reference: z.string().max(64).optional(),
  notes: z.string().max(2000).nullish(),
  currency: z.string().length(3).optional(),
  lines: z
    .array(
      z.object({
        description: z.string().min(1).max(300),
        amountMinor: minor,
        quantity: z.number().int().min(1).optional(),
        feeItemId: z.string().uuid().nullish(),
      }),
    )
    .min(1),
});
const paymentSchema = z.object({
  amountMinor: z.number().int().min(1),
  method: z.enum(PAYMENT_METHODS),
  kind: z.enum(["PAYMENT", "REFUND"]).optional(),
  reference: z.string().max(128).nullish(),
  note: z.string().max(500).nullish(),
  paidAt: z.string().datetime().optional(),
});

@RequireModule(MODULES.FEES)
@Controller()
export class FeesController {
  constructor(
    private readonly fees: FeesService,
    private readonly gateway: PaymentGatewayService,
  ) {}

  // --- online payments (Paystack) ---
  /** Start a hosted checkout for the invoice's balance; returns the pay URL. */
  @Post("invoices/:id/pay/init")
  @RequirePermission(FEES_PERMISSIONS.FEE_READ)
  payInit(@CurrentPrincipal() p: Principal, @Param("id") id: string) {
    return this.gateway.initInvoicePayment(p, id);
  }

  /** Paystack webhook (HMAC-verified). Public: it carries no session. */
  @Public()
  @Post("payments/webhook")
  webhook(
    @Req() req: RawBodyRequest<Request>,
    @Headers("x-paystack-signature") signature?: string,
  ) {
    return this.gateway.handleWebhook(req.rawBody, signature);
  }

  /** Send payment reminders to guardians of students with outstanding invoices. */
  @Post("fees/reminders/run")
  @RequirePermission(FEES_PERMISSIONS.FEE_MANAGE)
  sendReminders(@CurrentPrincipal() p: Principal, @Query("overdueOnly") overdueOnly?: string) {
    return this.fees.sendFeeReminders(p, { overdueOnly: overdueOnly === "true" });
  }

  // --- fee catalog (manage) ---
  @Get("fees/items")
  @RequirePermission(FEES_PERMISSIONS.FEE_MANAGE)
  listItems(@CurrentPrincipal() p: Principal): Promise<FeeItemDto[]> {
    return this.fees.listFeeItems(p);
  }

  @Post("fees/items")
  @RequirePermission(FEES_PERMISSIONS.FEE_MANAGE)
  createItem(
    @CurrentPrincipal() p: Principal,
    @Body(new ZodValidationPipe(feeItemSchema)) body: z.infer<typeof feeItemSchema>,
  ) {
    return this.fees.createFeeItem(p, body);
  }

  @Patch("fees/items/:id")
  @RequirePermission(FEES_PERMISSIONS.FEE_MANAGE)
  updateItem(
    @CurrentPrincipal() p: Principal,
    @Param("id") id: string,
    @Body(new ZodValidationPipe(feeItemUpdateSchema)) body: z.infer<typeof feeItemUpdateSchema>,
  ) {
    return this.fees.updateFeeItem(p, id, body);
  }

  // --- invoices ---
  @Post("invoices")
  @RequirePermission(FEES_PERMISSIONS.FEE_MANAGE)
  createInvoice(
    @CurrentPrincipal() p: Principal,
    @Body(new ZodValidationPipe(invoiceSchema)) body: z.infer<typeof invoiceSchema>,
  ) {
    return this.fees.createInvoice(p, body);
  }

  /** Receivables aging + collection summary (billing-wide staff). */
  @Get("fees/reports")
  @RequirePermission(FEES_PERMISSIONS.FEE_READ)
  reports(@CurrentPrincipal() p: Principal): Promise<FeeReportDto> {
    return this.fees.financeReport(p);
  }

  @Get("invoices")
  @RequirePermission(FEES_PERMISSIONS.FEE_READ)
  listInvoices(
    @CurrentPrincipal() p: Principal,
    @Query("studentId") studentId?: string,
    @Query("status") status?: string,
  ): Promise<InvoiceListItemDto[]> {
    const parsed = status && INVOICE_STATUSES.includes(status as never) ? (status as never) : undefined;
    return this.fees.listInvoices(p, { studentId, status: parsed });
  }

  @Get("invoices/:id")
  @RequirePermission(FEES_PERMISSIONS.FEE_READ)
  getInvoice(@CurrentPrincipal() p: Principal, @Param("id") id: string): Promise<InvoiceDetailDto> {
    return this.fees.getInvoice(p, id);
  }

  @Post("invoices/:id/issue")
  @RequirePermission(FEES_PERMISSIONS.FEE_MANAGE)
  issue(@CurrentPrincipal() p: Principal, @Param("id") id: string) {
    return this.fees.issueInvoice(p, id);
  }

  @Post("invoices/:id/cancel")
  @RequirePermission(FEES_PERMISSIONS.FEE_MANAGE)
  cancel(@CurrentPrincipal() p: Principal, @Param("id") id: string) {
    return this.fees.cancelInvoice(p, id);
  }

  // --- payments ---
  @Post("invoices/:id/payments")
  @RequirePermission(FEES_PERMISSIONS.FEE_MANAGE)
  recordPayment(
    @CurrentPrincipal() p: Principal,
    @Param("id") id: string,
    @Body(new ZodValidationPipe(paymentSchema)) body: z.infer<typeof paymentSchema>,
  ) {
    return this.fees.recordPayment(p, id, body);
  }

  @Get("invoices/:id/payments")
  @RequirePermission(FEES_PERMISSIONS.FEE_READ)
  listPayments(@CurrentPrincipal() p: Principal, @Param("id") id: string) {
    return this.fees.listPayments(p, id);
  }

  // --- maker-checker: the "checker" approves/rejects pending payments ---
  @Get("fees/payments/pending")
  @RequirePermission(FEES_PERMISSIONS.FEE_APPROVE)
  pending(@CurrentPrincipal() p: Principal): Promise<PendingPaymentDto[]> {
    return this.fees.listPendingPayments(p);
  }

  @Post("payments/:id/approve")
  @RequirePermission(FEES_PERMISSIONS.FEE_APPROVE)
  approvePayment(@CurrentPrincipal() p: Principal, @Param("id") id: string) {
    return this.fees.approvePayment(p, id);
  }

  @Post("payments/:id/reject")
  @RequirePermission(FEES_PERMISSIONS.FEE_APPROVE)
  rejectPayment(@CurrentPrincipal() p: Principal, @Param("id") id: string) {
    return this.fees.rejectPayment(p, id);
  }
}
