-- Per-school grace window: days past currentPeriodEnd before the effective plan
-- drops to the STANDARD floor. NULL -> platform default (SUBSCRIPTION_GRACE_DAYS,
-- 7). Set from the operator console (platform.grace.manage — delegable to
-- manager_admin because the API caps it at GRACE_DAYS_MAX; unbounded comping
-- stays owner-only via the subscription PUT). Nullable ADD COLUMN: no rewrite,
-- every existing school keeps the platform default.
ALTER TABLE "school_subscription" ADD COLUMN "graceDays" INTEGER;
