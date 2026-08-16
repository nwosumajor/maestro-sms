// Fees / Billing response DTOs (wire form: dates are ISO strings).

/** A page of invoices plus the cursor for the next one (null = end of list). */
export interface InvoicePageDto {
  items: InvoiceListItemDto[];
  nextCursor: string | null;
}

/** The headline figures on the fees page. Money in integer minor units. */
export interface InvoiceSummaryDto {
  outstandingMinor: number;
  collectedMinor: number;
  /** Billable invoices past their due date with a balance still owing. */
  overdueCount: number;
  currency: string;
}

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
  /** POSTED | PENDING_APPROVAL | REJECTED — receipts exist only for POSTED. */
  status: string;
  /** PAYMENT | REFUND | SCHOLARSHIP | CREDIT. */
  kind: string;
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
  /**
   * Whether this school can be set up at all, and if not, why — in words a
   * school can act on.
   *
   * Every school used to be shown the same picker, filled with NIGERIAN banks
   * whatever country it was in, and an account-number box that only accepted a
   * Nigerian NUBAN. A school in Accra could work through the whole form and
   * never succeed, with nothing on screen explaining why. Saying it up front is
   * the difference between a form and a dead end.
   */
  countryName: string | null;
  /** What to type: "10-digit NUBAN", "bank account number". */
  accountLabel: string | null;
  /** Null when settlement is available here. */
  blockedReason: string | null;
  /**
   * The school's own fee currency, and whether the platform's Paystack account
   * can actually charge it.
   *
   * A different question from whether Paystack supports the currency: verified
   * live, an account enabled only for NGN answers `403 Currency not supported
   * by merchant` for GHS, KES, ZAR and USD alike. The platform's static list
   * said otherwise, so those charges were routed here and the parent met a raw
   * gateway refusal at checkout. Null when it could not be determined.
   */
  feeCurrency: string | null;
  merchantCanChargeCurrency: boolean | null;
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
  /**
   * Parents' money that landed in the PLATFORM's gateway account because this
   * school had no settlement subaccount when the charge was made.
   *
   * The invoices are correctly PAID — the parents did pay — but the cash is the
   * platform's to release. Before this existed, that debt was recorded nowhere
   * and a school could go on collecting into someone else's balance believing
   * it had been paid. Surfaced so it is a visible balance rather than a silent
   * loss.
   */
  heldByPlatformMinor: number;
  /** How many payments make up `heldByPlatformMinor`. */
  heldPaymentCount: number;
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
