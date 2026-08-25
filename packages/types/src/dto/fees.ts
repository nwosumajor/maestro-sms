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

/**
 * A page of disputes, plus the school-wide count of OPEN ones.
 *
 * The list was the most-recent 200 with no filter and no way past them, on a
 * table the controller's own comment calls permanent — rls/78 grants no DELETE.
 * Worse than the truncation was what the page did with it: the "N open disputes
 * awaiting a response" banner was a MEMORY filter over those 200, ordered
 * newest-first. Disputes that stay OPEN are the ones nobody has answered, they
 * age, and ordering newest-first drops the oldest off the end — so the rows the
 * count existed to surface were exactly the rows it could not see. An unanswered
 * dispute is lost by default, which is money.
 *
 * `openTotal` is therefore counted in SQL and is school-wide — deliberately NOT
 * narrowed by the current filter, because it answers "is anything waiting on
 * us", not "how many did I just search for".
 */
export interface PaymentDisputePageDto {
  items: PaymentDisputeDto[];
  /** Matching the filter, not the page. */
  total: number;
  page: number;
  pageSize: number;
  /** OPEN disputes school-wide, whatever the current filter is. */
  openTotal: number;
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

/**
 * Per-school money policy, in the SCHOOL's own currency (0 flat late fee =
 * disabled).
 *
 * The two nullable fields were platform constants written in kobo and applied
 * to every school whatever its currency. NULL means "not set", and the two
 * resolve in opposite directions — see `effectivePaymentApprovalThresholdMinor`
 * and `effectiveLibraryFinePerDayMinor`. `currency` rides along so the screen
 * can label the boxes with the unit the figures are actually in.
 */
export interface LateFeeConfigDto {
  lateFeeFlatMinor: number;
  lateFeeGraceDays: number;
  /** Payments at or above this need a second approver. Null = not set. */
  paymentApprovalThresholdMinor: number | null;
  /** Overdue library fine per day. Null = not set. */
  libraryFinePerDayMinor: number | null;
  /** What the figures above are denominated in. */
  currency: string;
  /** The threshold actually in force, once the fail-safe has been applied —
   *  so the screen never has to re-derive the rule and disagree with the API. */
  effectiveApprovalThresholdMinor: number;
  /** The fine actually in force, likewise. */
  effectiveLibraryFinePerDayMinor: number;
}

/**
 * What a save SENDS. Deliberately not the read shape: `currency` and the two
 * `effective*` fields are DERIVED, and accepting them on a write would let a
 * caller assert a threshold that is not the one being enforced.
 */
export interface LateFeeConfigInput {
  lateFeeFlatMinor: number;
  lateFeeGraceDays: number;
  /** null CLEARS it back to the fail-safe; undefined leaves it unchanged. */
  paymentApprovalThresholdMinor?: number | null;
  libraryFinePerDayMinor?: number | null;
}

// =============================================================================
// The platform paying a school what it collected on its behalf
// =============================================================================
// A payment made before the school registered a settlement bank lands in the
// PLATFORM's gateway account. The invoice is correctly PAID and the cash is the
// platform's to hand over — and the only instruction the product could offer was
// "contact support to have this released", so the balance could only ever go up.
//
// A release does NOT move money; a person does that at a bank. It RECORDS the
// transfer — amount, the bank's own reference, date — and stamps the held
// payments it covers, so the balance falls because specific payments were
// discharged rather than because a total was edited.
export interface SettlementReleaseDto {
  id: string;
  amountMinor: number;
  currency: string;
  /** How many held payments this discharged. */
  paymentCount: number;
  /** The bank's reference for the transfer. */
  reference: string;
  note: string | null;
  releasedAt: Date;
}

export interface SettlementHoldingDto {
  schoolId: string;
  /** Still owed: platform-settled payments not yet covered by a release. */
  heldMinor: number;
  heldPaymentCount: number;
  /** Null when the held payments span more than one currency. */
  currency: string | null;
  /** Most recent first. */
  releases: SettlementReleaseDto[];
}
