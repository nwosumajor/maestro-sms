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
