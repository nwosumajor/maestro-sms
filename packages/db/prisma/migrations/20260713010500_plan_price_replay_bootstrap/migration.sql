-- =============================================================================
-- Ledger-replay bootstrap: create plan_price EARLY so the ledger replays
-- =============================================================================
-- The migration history had a real chronological gap. `20260713020000_multi_
-- currency_billing` ALTERs "plan_price", but that table is not CREATEd until the
-- LATER-stamped `20260726000000_plan_pricing`. The folder names were simply stamped
-- out of order relative to when they were authored: on every already-migrated
-- database the two ran in AUTHORING order (plan_pricing 2026-07-09 08:02, then
-- multi_currency_billing 2026-07-13 09:00), which is why live databases are
-- perfectly consistent.
--
-- But `prisma migrate deploy` applies migrations in NAME order, so a genuinely fresh
-- database ran the ALTER first and died with:
--     P3018 / 42P01  relation "plan_price" does not exist
-- That is why a fresh DB had to be built with `db push` instead of `migrate deploy`,
-- and why CI does exactly that.
--
-- The gap CANNOT be fixed by reordering or renaming the two folders: every
-- already-migrated environment (including the live compose stack) has recorded their
-- names and checksums, and changing either breaks all of them at once.
--
-- So instead this pair of migrations makes the ledger self-consistent WITHOUT
-- touching the historical files:
--   * this one          — creates plan_price in its ORIGINAL pre-ALTER shape, but
--                         ONLY if absent, so the ALTER that follows has a table.
--   * 20260725999999_*  — drops it again just before the real CREATE runs.
--
-- Both are no-ops on an already-migrated database. The marker COMMENT below is what
-- makes that safe: the drop fires ONLY for a table this bootstrap created, so a live
-- plan_price holding real operator-set pricing can never be caught by it.
-- =============================================================================

DO $$
BEGIN
  IF to_regclass('public.plan_price') IS NULL THEN
    -- Original shape, copied verbatim from 20260726000000_plan_pricing so the
    -- ALTERs in 20260713020000_multi_currency_billing land on exactly what they
    -- were written against (they add "currency" and repivot the primary key).
    CREATE TABLE "plan_price" (
        "plan" TEXT NOT NULL,
        "perSeatMonthlyMinor" INTEGER NOT NULL,
        "updatedAt" TIMESTAMP(3) NOT NULL,

        CONSTRAINT "plan_price_pkey" PRIMARY KEY ("plan")
    );

    -- The marker. Its exact text is matched by the companion drop migration; do not
    -- reword one without the other.
    COMMENT ON TABLE "plan_price" IS
      'ledger-replay bootstrap (20260713010500) — dropped by 20260725999999 before the real CREATE';
  END IF;
END $$;
