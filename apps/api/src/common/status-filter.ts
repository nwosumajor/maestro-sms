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

/**
 * A page number or page size from a query string, or a refusal.
 *
 * `page ? Number(page) : 1` is the shape this replaces, and it has three
 * failure modes, all of which reached the database:
 *
 *   `?page=abc`     -> NaN      -> `skip: NaN`      -> PrismaClientValidationError
 *   `?page=1e999`   -> Infinity -> `skip: Infinity` -> the same
 *   `?pageSize=1e9` -> a take nobody meant
 *
 * Measured live: `?page=abc` on `/students/exited`, `/operator/tenants` and
 * `/operator/payments` each returned **500 Internal server error** — and,
 * through the observability spine, raised a Sentry event. A query-string typo
 * on the platform owner's own console became an error-tracking alert with a
 * stack trace, where the caller needed one sentence telling them what to type.
 *
 * A 400 is also what this API already does everywhere it uses Zod:
 * `/workflows`, `/admissions`, `/assessments` and `/fees/disputes` all answer
 * `z.coerce.number().int().min(1)` with a 400. The hand-rolled sites were the
 * outliers, not the rule.
 */
export function pageNumber(value: string | undefined | null, field = "page", max = 1_000_000): number | undefined {
  const v = value?.trim();
  // Absent means "the caller did not ask" — the handler's own default applies.
  if (!v) return undefined;
  const n = Number(v);
  if (!Number.isSafeInteger(n) || n < 1 || n > max) {
    throw new BadRequestException(`${field} must be a whole number between 1 and ${max}`);
  }
  return n;
}
