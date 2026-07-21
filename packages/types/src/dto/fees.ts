// Fees / Billing response DTOs (wire form: dates are ISO strings).

export interface InvoiceListItemDto {
  id: string;
  reference: string;
  status: string;
  currency: string;
  totalMinor: number;
  dueDate: Date;
}

export interface InvoiceLineItemDto {
  id: string;
  description: string;
  amountMinor: number;
  quantity: number;
}

export interface InvoicePaymentDto {
  id: string;
  amountMinor: number;
  method: string;
  paidAt: Date;
  reference: string | null;
}

export interface InvoiceDetailDto {
  id: string;
  /** The billed student (drives the virtual-account card on the detail page). */
  studentId: string;
  reference: string;
  status: string;
  currency: string;
  totalMinor: number;
  amountPaidMinor: number;
  balanceMinor: number;
  overdue: boolean;
  dueDate: Date;
  notes: string | null;
  lineItems: InvoiceLineItemDto[];
  payments: InvoicePaymentDto[];
}

export interface PendingPaymentDto {
  id: string;
  amountMinor: number;
  kind: string;
  method: string;
  invoiceId: string;
}

export interface FeeItemDto {
  id: string;
  name: string;
  amountMinor: number;
  currency: string;
}

export interface FeeReportBucketDto {
  count: number;
  amountMinor: number;
}

export interface FeeReportDto {
  scope: "school" | "none";
  totals?: { invoicedMinor: number; collectedMinor: number; outstandingMinor: number };
  aging?: {
    current: FeeReportBucketDto;
    d1_30: FeeReportBucketDto;
    d31_60: FeeReportBucketDto;
    d60plus: FeeReportBucketDto;
  };
  pendingApprovals?: { count: number; amountMinor: number };
}

/** The school's fee SETTLEMENT posture (Paystack split). Never carries the
 *  full account number — display fields only. */
export interface SettlementAccountDto {
  /** True once a subaccount exists — fee charges then split to the school's bank. */
  configured: boolean;
  bankCode: string | null;
  bankName: string | null;
  accountLast4: string | null;
  subaccountCode: string | null;
  /** Who bears the platform's online-payment convenience fee for THIS school
   *  (null = the platform-wide default applies). */
  feeBearer: "PARENT" | "SCHOOL" | null;
  /** The platform fee that would apply to a sample ₦10,000 payment — shown to
   *  the school so the bearer choice is an informed one. */
  sampleFeeMinor: number;
}

/** Returned by the pay-online init so the payer sees the full charge before the
 *  gateway redirect. */
export interface InvoicePayInitDto {
  authorizationUrl: string;
  reference: string;
  /** The invoice balance being settled. */
  invoiceAmountMinor: number;
  /** Platform convenience fee (0 when none / school-borne). */
  feeMinor: number;
  /** What the payer's card is actually charged. */
  chargedMinor: number;
}

/** Gateway dispute lifecycle: OPEN -> RESPONDED (staff recorded evidence) ->
 *  WON/LOST (gateway resolution via webhook). */
export type DisputeStatus = "OPEN" | "RESPONDED" | "WON" | "LOST";

/** A gateway chargeback/dispute against an online payment (server form —
 *  the web consumes Serialized<PaymentDisputeDto>). */
export interface PaymentDisputeDto {
  id: string;
  /** Gateway's dispute id (idempotency/update key for webhook events). */
  gatewayDisputeId: string;
  /** The disputed charge's gateway reference. */
  transactionReference: string;
  /** The disputed POSTED payment / its invoice, when the reference resolved. */
  paymentId: string | null;
  invoiceId: string | null;
  amountMinor: number;
  currency: string;
  /** Gateway category (e.g. "chargeback", "fraud"). */
  category: string | null;
  status: DisputeStatus;
  gatewayStatus: string | null;
  /** Evidence deadline — respond before this or lose by default. */
  dueAt: Date | null;
  responseNote: string | null;
  respondedAt: Date | null;
  resolution: string | null;
  resolvedAt: Date | null;
  createdAt: Date;
}

/** A student's dedicated NUBAN (virtual bank account) for fee transfers. */
export interface VirtualAccountDto {
  studentId: string;
  accountNumber: string;
  bankName: string;
  active: boolean;
  createdAt: Date;
}

/** One tranche of an invoice payment plan; state DERIVED from cumulative paid. */
export interface InstallmentDto {
  seq: number;
  dueDate: Date;
  amountMinor: number;
  state: "PAID" | "DUE" | "OVERDUE" | "UPCOMING";
}

export interface PaymentPlanDto {
  invoiceId: string;
  tranches: InstallmentDto[];
}

/** Append-only credit-ledger entry (positive = credit in, negative = applied). */
export interface CreditEntryDto {
  id: string;
  deltaMinor: number;
  reason: string;
  reference: string | null;
  note: string | null;
  createdAt: Date;
}

export interface CreditBalanceDto {
  studentId: string;
  balanceMinor: number;
  entries: CreditEntryDto[];
}

/** A maker-checker discount/waiver on an invoice. */
export interface InvoiceAdjustmentDto {
  id: string;
  invoiceId: string;
  kind: "DISCOUNT" | "WAIVER";
  amountMinor: number;
  reason: string;
  status: "PENDING_APPROVAL" | "APPROVED" | "REJECTED";
  requestedById: string;
  approvedById: string | null;
  createdAt: Date;
}

/** Per-school automatic late-fee policy (0 flat = disabled). */
export interface LateFeeConfigDto {
  lateFeeFlatMinor: number;
  lateFeeGraceDays: number;
}
