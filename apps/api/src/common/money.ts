// =============================================================================
// Money at the database boundary
// =============================================================================
// The columns whose single-row value can exceed a 32-bit integer are BIGINT:
// a multi-year subscription charge, a school-wide payroll total, a
// platform-funded scholarship budget. Prisma maps int8 to a JavaScript
// `bigint`, and a bigint does two inconvenient things: it throws inside
// JSON.stringify, and it refuses to mix with `number` in arithmetic.
//
// So every read of one crosses back to `number` HERE, in one place, rather than
// each call site inventing its own cast. A stray `Number(x)` sprinkled around
// money code is how a precision bug gets introduced quietly.
//
// WHY `number` IS THE RIGHT DESTINATION. These are integer counts of minor
// units, and a double represents every integer exactly up to 2^53 —
// 9,007,199,254,740,991, or about NGN 90 trillion. No school's payroll and no
// platform's subscription charge comes within nine orders of magnitude of that.
// Carrying bigint through the app instead would mean bigint-aware arithmetic,
// bigint-aware DTOs and a JSON serialiser patch, to buy headroom nobody needs.
//
// The guard is the point: if a figure ever DOES exceed what a double can hold
// exactly, that must be loud. Silently rounding money is the exact class of
// defect this widening exists to remove, and it would be far harder to notice
// than the 500 the int4 ceiling used to throw.
// =============================================================================

import { Logger } from "@nestjs/common";

const logger = new Logger("Money");

/**
 * A minor-unit figure read from a BIGINT column, as a plain number.
 *
 * Accepts `number` too, so a call site does not have to know whether the column
 * it just read has been widened yet — which keeps this usable during a partial
 * migration instead of forcing one big-bang change.
 */
export function toMinor(value: bigint | number | null | undefined, fallback = 0): number {
  if (value == null) return fallback;
  if (typeof value === "number") return value;
  if (value > BigInt(Number.MAX_SAFE_INTEGER) || value < BigInt(-Number.MAX_SAFE_INTEGER)) {
    // Never silently round money. Loud, with the value, so whoever reads the
    // log can see exactly which figure broke the assumption above.
    logger.error(
      `Money value ${value.toString()} exceeds the exact-integer range of a double. ` +
        `Refusing to round it — see apps/api/src/common/money.ts.`,
    );
    throw new Error("Money value too large to represent exactly");
  }
  return Number(value);
}

/** The nullable form: keeps `null` distinct from zero. A subscription that has
 *  never been charged has no price; it does not have a price of nothing. */
export function toMinorOrNull(value: bigint | number | null | undefined): number | null {
  return value == null ? null : toMinor(value);
}
