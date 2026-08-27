// =============================================================================
// What an invoice has actually been paid
// =============================================================================
// ONE definition of "paid", because there were fifteen hand-written copies of it
// and three places that used a Prisma aggregate which cannot express it at all.
//
// The rule, as `FeesService.paidMinor` has always stated it: **POSTED payments
// minus POSTED refunds. PENDING_APPROVAL and REJECTED rows never count toward
// the balance.**
//
// `_sum: { amountMinor: true }` cannot subtract a REFUND, so the aggregate sites
// approximated it two different ways and BOTH understate what a family owes:
//
//   where: { status: POSTED, kind: PAYMENT }   refunds EXCLUDED
//       -> outstanding short by the refund
//   where: { status: POSTED }                  refunds added as POSITIVE
//       -> outstanding short by TWICE the refund
//
// On an invoice of 500 paid 300 and refunded 100, the school is owed 300. The
// first shape says 200; the second says 100. The card rail, which does the
// reduce properly, says 300 — verified live against the same invoice.
//
// A balance that is too LOW is the dangerous direction: it is the number a
// payment rail asks a parent for, and the number a leaver's transcript decision
// is taken on.
// =============================================================================

import type { TenantTx } from "../integrity/integrity.foundation";

type PaymentRow = { amountMinor: number; kind: string };

/** Net of a set of already-loaded payment rows. POSTED filtering is the caller's. */
export function netPaidOf(rows: readonly PaymentRow[]): number {
  return rows.reduce((n, p) => n + (p.kind === "REFUND" ? -p.amountMinor : p.amountMinor), 0);
}

/** Net paid on ONE invoice: POSTED payments minus POSTED refunds. */
export async function netPaidMinor(tx: TenantTx, invoiceId: string): Promise<number> {
  const posted = (await tx.payment.findMany({
    where: { invoiceId, status: "POSTED" },
    select: { amountMinor: true, kind: true },
  })) as PaymentRow[];
  return netPaidOf(posted);
}

/**
 * Net paid per invoice for a whole set of invoices — the batched form, for the
 * screens that price many pupils at once.
 *
 * A `groupBy` would be one round trip instead of one, and cannot express the
 * refund sign; this is the trade, and it is the correct number.
 */
export async function netPaidByInvoice(
  tx: TenantTx,
  where: Record<string, unknown>,
): Promise<Map<string, number>> {
  const rows = (await tx.payment.findMany({
    where: { ...where, status: "POSTED" },
    select: { invoiceId: true, amountMinor: true, kind: true },
  })) as Array<PaymentRow & { invoiceId: string }>;
  const out = new Map<string, number>();
  for (const r of rows) {
    out.set(r.invoiceId, (out.get(r.invoiceId) ?? 0) + (r.kind === "REFUND" ? -r.amountMinor : r.amountMinor));
  }
  return out;
}
