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

/**
 * The status an invoice's money says it should carry — the ONE rule.
 *
 * Seven writers decided this, spelled five ways: four the full rule, two with
 * no ISSUED branch (sound only because they ran after money was added), and the
 * library keeping the old status rather than issuing a DRAFT. Each was right
 * where it stood; a rule written seven times is the shape that goes wrong on
 * the eighth. `ledger-integrity` checks stored statuses against this same rule
 * in SQL, and `one-rule-for-paid.spec` fails on a new spelling of it.
 *
 * `whenUnpaid` is the status for nothing paid. ISSUED for a bill that has been
 * issued; the library passes the invoice's CURRENT status so a fine landing on
 * a DRAFT does not issue it as a side effect.
 */
export function invoiceStatusForNet(netPaidMinor: number, totalMinor: number): "PAID" | "PARTIALLY_PAID" | "ISSUED";
export function invoiceStatusForNet<U extends string>(
  netPaidMinor: number,
  totalMinor: number,
  whenUnpaid: U,
): "PAID" | "PARTIALLY_PAID" | U;
export function invoiceStatusForNet(netPaidMinor: number, totalMinor: number, whenUnpaid: string = "ISSUED"): string {
  if (netPaidMinor >= totalMinor) return "PAID";
  if (netPaidMinor > 0) return "PARTIALLY_PAID";
  return whenUnpaid;
}
