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

/**
 * A whole number from a query string, or a refusal.
 *
 * `pageNumber` generalised: `?limit=`, `?days=`, `?year=` are the same input
 * class and were failing in the same two ways.
 *
 * // GOTCHA: `Math.min(Math.max(Number(x) ?? D, 1), MAX)` looks like it clamps
 * and does not. `??` never fires for NaN — NaN is not null — so the default is
 * unreachable, `Math.max(NaN, 1)` is NaN, and `take: NaN` reaches Prisma.
 * Measured live: `/security/audit?limit=abc` and
 * `/notifications/deliveries/problems?days=abc` both **500**.
 *
 * The other half is worse, because it answers. `hr/attendance/summary` reads
 * `Number(year)` and the SERVICE treats NaN as "not given" — a comment there
 * says so, written while fixing a 500 on a call with no parameters at all. It
 * closed that hole and opened this one: `?year=abc` silently reports the
 * CURRENT month under the year the caller asked for. Clamping a number that is
 * out of range is fine — a limit is a request. Guessing at one that is not a
 * number is not — that is a mistake, and the caller wants to know.
 */
export function boundedInt(
  value: string | undefined | null,
  opts: { field: string; min?: number; max?: number },
): number | undefined {
  const { field, min = 1, max = 1_000_000 } = opts;
  const v = value?.trim();
  if (!v) return undefined;
  const n = Number(v);
  if (!Number.isSafeInteger(n) || n < min || n > max) {
    throw new BadRequestException(`${field} must be a whole number between ${min} and ${max}`);
  }
  return n;
}

/** The two shapes a caller legitimately sends for a day. */
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const ISO_STAMP = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2})?(\.\d{1,3})?(Z|[+-]\d{2}:?\d{2})?$/;

/**
 * One end of a date window, or a refusal.
 *
 * ACCEPTS BOTH FORMATS, which is half the point. The revenue ledger's own
 * `range()` tested `/^\d{4}-\d{2}-\d{2}$/` and SILENTLY DROPPED anything else,
 * so `?from=2026-08-01T00:00:00Z` — not a typo, just the shape `toISOString()`
 * produces, which is what any script or export tool sends — returned the
 * ALL-TIME total under an August caption. Measured live on the platform
 * owner's console: 17 payments and NGN 25,700,236.64 for a window that held a
 * fraction of it. That file's own header explains that these filters live in
 * the URL so "a finance query is a link… bookmarked, shared with an
 * accountant" — which makes a hand-held URL a first-class input, not an edge
 * case.
 *
 * The other sites took `new Date(value)` unguarded and answered **500** on the
 * same input: `/analytics/overview`, `/attendance/by-class`, `/exams`,
 * `/library/report`, `/security/audit`, `/hr/leave/calendar`. Three siblings
 * already got it right (`/events` "Invalid window",
 * `/fees/export/journal.csv` "from/to must be YYYY-MM-DD", `/timetable/cover`
 * "Invalid date range") — three separate hand-rolled refusals with three
 * different messages, which is the shape that precedes a fourth being
 * forgotten.
 *
 * `end: true` snaps a DATE-ONLY value to the last millisecond of that day, so
 * `to=2026-08-26` includes the 26th. A caller who sent a TIMESTAMP meant that
 * instant and it is left alone — snapping it would move a boundary they chose.
 */
export function dateFilter(
  value: string | undefined | null,
  field: string,
  opts: { end?: boolean } = {},
): Date | undefined {
  const v = value?.trim();
  if (!v) return undefined;
  const dateOnly = DATE_ONLY.test(v);
  if (!dateOnly && !ISO_STAMP.test(v)) {
    throw new BadRequestException(`${field} must be a date (YYYY-MM-DD) or an ISO 8601 timestamp`);
  }
  // A shape that parses is not a date that exists: "2026-13-45" passes the
  // pattern and `new Date` yields Invalid Date, which reaches Prisma as a 500
  // exactly like the unguarded sites did.
  const d = new Date(dateOnly ? `${v}T${opts.end ? "23:59:59.999" : "00:00:00.000"}Z` : v);
  if (Number.isNaN(d.getTime())) {
    throw new BadRequestException(`${field} is not a real date`);
  }
  return d;
}

/**
 * Both ends of a window at once, refusing a backwards one.
 *
 * A `from` after its `to` matches nothing and renders as "no payments in that
 * period" — true of the query and false of the world, which is the same
 * confident-false-statement this whole file exists for.
 */
export function dateWindow(
  from: string | undefined | null,
  to: string | undefined | null,
  fields: { from: string; to: string } = { from: "from", to: "to" },
): { from?: Date; to?: Date } {
  const gte = dateFilter(from, fields.from);
  const lte = dateFilter(to, fields.to, { end: true });
  if (gte && lte && gte > lte) {
    throw new BadRequestException(`${fields.from} must not be after ${fields.to}`);
  }
  return { from: gte, to: lte };
}
