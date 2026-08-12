-- A departed pupil's record is kept for a bounded time, then a HUMAN disposes
-- of it. Years, not days: school records are governed in years, and a leaver's
-- academic record must outlive the integrity telemetry window by a long way
-- because a transcript can be requested many years after leaving.
--
-- Default 7 is a common statutory floor, not a claim about any one country's
-- law. Nothing purges on this value — the sweep only reports what is DUE, so a
-- wrong default costs a school a misleading report rather than lost records.
ALTER TABLE "school" ADD COLUMN IF NOT EXISTS "leaverRetentionYears" INTEGER NOT NULL DEFAULT 7;
