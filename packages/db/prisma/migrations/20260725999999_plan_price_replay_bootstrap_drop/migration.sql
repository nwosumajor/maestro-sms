-- =============================================================================
-- Ledger-replay bootstrap, part 2: remove the placeholder before the real CREATE
-- =============================================================================
-- Companion to 20260713010500_plan_price_replay_bootstrap — read that file first for
-- why the pair exists. This migration is stamped to sort immediately BEFORE
-- 20260726000000_plan_pricing, whose plain `CREATE TABLE "plan_price"` would
-- otherwise collide with the placeholder on a fresh replay.
--
-- SAFETY — this is the file that could do real damage, so it is deliberately narrow.
-- It drops plan_price ONLY when the table still carries the bootstrap's marker
-- comment, i.e. only a table this pair created moments earlier and that nothing has
-- yet written to. On an already-migrated database plan_price was created by
-- 20260726000000_plan_pricing and carries no such comment, so the condition is false
-- and the migration is a no-op — operator-set tier pricing is never at risk.
--
-- A plain `DROP TABLE IF EXISTS` here would be catastrophic on a live database: it
-- would silently delete real pricing and the next request would fall back to the
-- hard-coded PLAN_PRICING defaults, quietly billing every school the wrong amount.
-- The marker check is the whole point.
-- =============================================================================

DO $$
DECLARE
  marker text;
BEGIN
  IF to_regclass('public.plan_price') IS NULL THEN
    RETURN; -- nothing to do
  END IF;

  marker := obj_description('public.plan_price'::regclass, 'pg_class');

  IF marker = 'ledger-replay bootstrap (20260713010500) — dropped by 20260725999999 before the real CREATE' THEN
    DROP TABLE "plan_price";
    RAISE NOTICE 'dropped the plan_price replay bootstrap; 20260726000000_plan_pricing will create the real table';
  END IF;
END $$;
