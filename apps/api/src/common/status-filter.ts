// =============================================================================
// A filter nobody validated answers a question nobody asked
// =============================================================================
// A `?status=` a route does not recognise fails in one of two ways, and BOTH
// are worse than an error:
//
//   passed straight into the query  -> matches nothing -> "no boarders are
//                                      signed out", "no books are on loan"
//   quietly dropped to undefined    -> matches everything -> the whole ledger,
//                                      under the label the user picked
//
// Measured live across the API: `GET /library/loans?status=OUT` turned 26 loans
// into 0 with a 200; `GET /hostels/exeats?status=…` turned one overdue boarder
// into none; `GET /invoices?status=OVERDUE` returned all 14 invoices as though
// they were. A safety statement about children, and a statement about money,
// each made by a typo.
//
// ONE helper rather than a hand-rolled check per route: this repo has already
// recorded what happens otherwise — "the CSV formula guard existed 9x under 4
// names" — and a control written nine times is a control that will be right
// eight times.
// =============================================================================

import { BadRequestException } from "@nestjs/common";

/**
 * Narrow a caller's `?status=` to a known set, or refuse.
 *
 * Returns `undefined` for an absent value (no filter — the whole list, which is
 * what the caller asked for) and the value itself when it is recognised. It
 * never returns a value the caller did not send, and never silently discards
 * one they did.
 *
 * The refusal NAMES the allowed values: "status must be one of ISSUED,
 * RETURNED" is something a caller can act on, where "invalid status" sends them
 * to read the source.
 */
export function narrowStatus<T extends string>(
  value: string | undefined | null,
  allowed: readonly T[],
  field = "status",
): T | undefined {
  // An empty string is not a filter — a cleared dropdown submits one, and
  // refusing that would break the ordinary "show me everything" case.
  const v = value?.trim();
  if (!v) return undefined;
  if (!(allowed as readonly string[]).includes(v)) {
    throw new BadRequestException(`${field} must be one of ${allowed.join(", ")}`);
  }
  return v as T;
}
