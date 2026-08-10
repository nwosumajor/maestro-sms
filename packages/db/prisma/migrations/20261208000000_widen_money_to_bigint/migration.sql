-- Widen the money columns whose SINGLE-ROW value can exceed a 32-bit integer.
--
-- int4 tops out at 2,147,483,647 minor units — about NGN 21.4m. Two of these
-- were already reachable in ordinary use:
--
--   * platform_subscription_payment.amountMinor — a multi-year ENTERPRISE
--     charge is NGN 43m, and even a SINGLE academic year passes the ceiling at
--     roughly 3,500 students. It surfaced as a raw driver 500 after the bursar
--     had re-authenticated.
--   * payroll_run.totalGross/totalNetMinor — a school-wide monthly payroll.
--     150 staff averaging NGN 150k is NGN 22.5m, so a mid-sized school would
--     have hit this on a normal payroll run.
--
-- The rest travel with them: a subscription's priceMinor mirrors the charge
-- that set it, arrears accumulate until collected, and a platform-funded
-- scholarship budget is a whole-programme figure rather than a per-pupil one.
--
-- DELIBERATELY NOT WIDENED: per-pupil amounts (invoice totals, invoice lines,
-- fee payments, credits, fares, rents, fines). One pupil's termly fees cannot
-- approach NGN 21m, and widening money that does not need it costs storage and
-- index size on the largest tables in the system for no benefit. Postgres
-- already promotes SUM(int4) to bigint, so aggregates over those were never at
-- risk — only single-row values are.
--
-- Widening is safe and non-destructive: every existing int4 value fits in an
-- int8, so this rewrites the column type without touching a single figure.
ALTER TABLE "platform_subscription_payment" ALTER COLUMN "amountMinor"  TYPE BIGINT;
ALTER TABLE "platform_subscription_payment" ALTER COLUMN "arrearsMinor" TYPE BIGINT;

ALTER TABLE "school_subscription" ALTER COLUMN "priceMinor"       TYPE BIGINT;
ALTER TABLE "school_subscription" ALTER COLUMN "seatArrearsMinor" TYPE BIGINT;

ALTER TABLE "payroll_run" ALTER COLUMN "totalGrossMinor" TYPE BIGINT;
ALTER TABLE "payroll_run" ALTER COLUMN "totalNetMinor"   TYPE BIGINT;

ALTER TABLE "scholarship_program" ALTER COLUMN "budgetMinor" TYPE BIGINT;

-- The operator revenue ledger orders by createdAt and filters on a period.
-- Measured at 150,000 rows (about ten years for a 5,000-school platform) the
-- plan was a Parallel Seq Scan: 40ms, which is fine today and linear for ever
-- after. This table only ever grows — nothing prunes a financial record.
CREATE INDEX IF NOT EXISTS "platform_subscription_payment_createdAt_idx"
  ON "platform_subscription_payment" ("createdAt");
