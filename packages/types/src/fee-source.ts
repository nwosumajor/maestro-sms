// =============================================================================
// Which part of the school a charge came from
// =============================================================================
// Hostel rent, transport fares, library fines and tuition all land on the SAME
// `invoice_line_item` table — deliberately, so a family gets one bill and one
// balance rather than four. What was missing is which part of the school raised
// each line, so "what did boarding bring in this term?" had no answer.
//
// // GOTCHA: the only thing that LOOKED like an answer was the line's
// `description`, and attributing money by it would have been worse than having
// no report. Hostel writes `input.description ?? "Hostel rent"` and transport
// `input.description ?? "Transport fare"` — OPERATOR-SUPPLIED FREE TEXT. A
// bursar who types "Boarding — Michaelmas" produces a line indistinguishable
// from tuition, so the figures would drift silently as schools worded their own
// fee runs, and nothing on the page could show that they had.
//
// So the source is RECORDED BY THE MODULE THAT RAISES THE CHARGE, at the moment
// it raises it, and never inferred afterwards.
// =============================================================================

export const FEE_SOURCES = {
  /** Academic fees — the school's own catalogue items. */
  TUITION: "TUITION",
  HOSTEL: "HOSTEL",
  TRANSPORT: "TRANSPORT",
  LIBRARY: "LIBRARY",
  /** Charged by the overdue sweep, not by any one department. */
  LATE_FEE: "LATE_FEE",
  /** An approved discount or waiver — always NEGATIVE, so it reduces whatever
   *  it was granted against rather than reading as income. */
  ADJUSTMENT: "ADJUSTMENT",
} as const;

export type FeeSource = (typeof FEE_SOURCES)[keyof typeof FEE_SOURCES];

export const FEE_SOURCE_LABELS: Record<FeeSource, string> = {
  TUITION: "School fees",
  HOSTEL: "Hostel",
  TRANSPORT: "Transport",
  LIBRARY: "Library",
  LATE_FEE: "Late fees",
  ADJUSTMENT: "Discounts & waivers",
};

export function isFeeSource(v: unknown): v is FeeSource {
  return typeof v === "string" && v in FEE_SOURCES;
}

/** One department's money, in ONE currency. */
export interface FeeSourceRevenueDto {
  /** A `FeeSource`, or `UNATTRIBUTED` for lines raised before sources existed. */
  source: string;
  label: string;
  /** What was billed — exact, straight off the line items. */
  billedMinor: number;
  /**
   * What has been collected against it.
   *
   * A payment settles an INVOICE, not a line, so on an invoice that mixes (say)
   * tuition and hostel rent a part payment does not say which part it paid.
   * This apportions each posted payment across that invoice's lines PRO RATA by
   * line amount — the ordinary convention for an unallocated receipt. On a
   * single-source invoice it is exact.
   *
   * // GOTCHA: mixing is COMMON, not a corner case, and measuring it corrected
   * my own first guess here. The hostel and transport runs APPEND to a family's
   * existing DRAFT invoice when there is one and only raise their own when
   * there is not — which is the right product behaviour, since the whole point
   * is one bill per family. Measured on real data: 19 invoices carried more
   * than one department against 25 that did not. So `mixedCollectedMinor` is
   * not a footnote about a rare case; it is a material share of the collected
   * figure, and the page states it rather than letting a convention read as a
   * measurement.
   */
  collectedMinor: number;
  /** Still owed, on the same apportionment. */
  outstandingMinor: number;
  lineCount: number;
}

export interface FeeSourceReportDto {
  currency: string;
  sources: FeeSourceRevenueDto[];
  billedMinor: number;
  collectedMinor: number;
  outstandingMinor: number;
  /**
   * How much of `collectedMinor` was apportioned from invoices carrying more
   * than one source. Exact figures come from single-source invoices; this is
   * the part that rests on the pro-rata convention.
   */
  mixedCollectedMinor: number;
}
