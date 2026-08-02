-- The retention sweep purged three tables of minors' telemetry and left two
-- others growing for ever: `xapi_statement` (every learning interaction, and
-- xAPI is firehose-shaped by design) and `scan_event` (every gate, library and
-- exam-hall check-in). Both are behavioural telemetry about children — exactly
-- what Golden Rule #5 names — and the app role is INSERT/SELECT only on both,
-- so a retention sweep is the ONLY thing that can ever make them smaller.
--
-- Recorded per run, like the other three, so "what did we delete and when" stays
-- answerable. DEFAULT 0 rather than NULL: past runs really did purge none of
-- these, and a zero says that honestly where a null would be ambiguous.
ALTER TABLE "integrity_retention_run" ADD COLUMN IF NOT EXISTS "xapiDeleted"  INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "integrity_retention_run" ADD COLUMN IF NOT EXISTS "scansDeleted" INTEGER NOT NULL DEFAULT 0;
