// Pure value formatting for the chart axes and tooltips — no recharts, so it can
// be tested directly.
//
// Money arrives already in MAJOR units, converted by the caller with `toMajor()`,
// which knows a CFA franc has no minor unit at all. Both halves of this used to
// be wrong together: the caller divided by 100 and this prefixed a hard-coded ₦,
// so a Ghanaian school's fee chart was labelled in naira and a Senegalese
// school's showed one hundredth of what it had invoiced.

export const nfCompact = (n: number): string =>
  Math.abs(n) >= 1000 ? `${(n / 1000).toFixed(n % 1000 === 0 ? 0 : 1)}k` : `${n}`;

/** A chart value. `money` formats in the SCHOOL's currency, never the platform's. */
export function fmtVal(n: number, money?: boolean, currency?: string, locale?: string): string {
  if (!money) return n.toLocaleString();
  try {
    return new Intl.NumberFormat(locale || "en", {
      style: "currency",
      currency: currency || "NGN",
      notation: "compact",
      maximumFractionDigits: 1,
    }).format(n);
  } catch {
    // A school's fee currency is a free-form ISO column, so an unrecognised code
    // must degrade to a readable number rather than blanking the chart.
    return `${currency ?? ""}${nfCompact(n)}`.trim();
  }
}
