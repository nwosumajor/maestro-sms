-- =============================================================================
-- attendance_term_rollup — per-term attendance totals, precomputed
-- =============================================================================
-- The analytics attendance aggregate scans every register row in the window. At
-- 3,000 pupils that is ~180,000 rows for ONE term (measured: 50.6 ms), and it grows
-- linearly with every term a school keeps — five years of registers is ~900,000 rows
-- and roughly a quarter of a second, on a page that is opened constantly.
--
-- WHY A TABLE AND NOT A MATERIALIZED VIEW: a matview cannot carry row-level security,
-- and this data is per-tenant. A real tenant-scoped table keeps the same RLS
-- guarantee as everything else (prisma/rls/98).
--
-- WHY IT CANNOT GO STALE: only ENDED terms are ever written here. AttendanceService
-- refuses every write to a register dated before the current term's start — locked
-- for everyone, no approval path — so an ended term's records are immutable and a
-- rollup of them can never drift. The CURRENT term is always computed live. There is
-- deliberately no cache-invalidation mechanism, because there is nothing to
-- invalidate.
--
-- Grain (term, class, student) answers the school's, the class's and the pupil's
-- term attendance from the same rows, and stays small: ~9,000 rows a year at 3,000
-- pupils versus the ~540,000 raw records behind them.
--
-- Guarded throughout so re-running is a no-op: a failed migration blocks every later
-- one and takes the API down on boot (PR #21).
-- =============================================================================

CREATE TABLE IF NOT EXISTS "attendance_term_rollup" (
    "id"         UUID NOT NULL,
    "schoolId"   UUID NOT NULL,
    "termId"     UUID NOT NULL,
    "classId"    UUID NOT NULL,
    "studentId"  UUID NOT NULL,
    "present"    INTEGER NOT NULL DEFAULT 0,
    "absent"     INTEGER NOT NULL DEFAULT 0,
    "late"       INTEGER NOT NULL DEFAULT 0,
    "excused"    INTEGER NOT NULL DEFAULT 0,
    "total"      INTEGER NOT NULL DEFAULT 0,
    "computedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "attendance_term_rollup_pkey" PRIMARY KEY ("id")
);

-- The upsert key: recomputing a term REPLACES its rows rather than duplicating them.
CREATE UNIQUE INDEX IF NOT EXISTS "attendance_term_rollup_termId_classId_studentId_key"
  ON "attendance_term_rollup"("termId", "classId", "studentId");

CREATE INDEX IF NOT EXISTS "attendance_term_rollup_schoolId_idx"
  ON "attendance_term_rollup"("schoolId");
-- Serves the school-wide term figure.
CREATE INDEX IF NOT EXISTS "attendance_term_rollup_schoolId_termId_idx"
  ON "attendance_term_rollup"("schoolId", "termId");
-- Serves the per-class breakdown senior staff drill into.
CREATE INDEX IF NOT EXISTS "attendance_term_rollup_schoolId_termId_classId_idx"
  ON "attendance_term_rollup"("schoolId", "termId", "classId");

DO $$
BEGIN
  -- RESTRICT to school (Golden Rule #1, the convention all tenant tables share).
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'attendance_term_rollup_schoolId_fkey') THEN
    ALTER TABLE "attendance_term_rollup" ADD CONSTRAINT "attendance_term_rollup_schoolId_fkey"
      FOREIGN KEY ("schoolId") REFERENCES "school"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
  -- CASCADE from term and class: a rollup of a deleted term or class is meaningless
  -- on its own, and it is derived data that can always be rebuilt.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'attendance_term_rollup_termId_fkey') THEN
    ALTER TABLE "attendance_term_rollup" ADD CONSTRAINT "attendance_term_rollup_termId_fkey"
      FOREIGN KEY ("termId") REFERENCES "term"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'attendance_term_rollup_classId_fkey') THEN
    ALTER TABLE "attendance_term_rollup" ADD CONSTRAINT "attendance_term_rollup_classId_fkey"
      FOREIGN KEY ("classId") REFERENCES "class"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  -- studentId follows the documented "scalar column + DB FK, no Prisma relation"
  -- pattern that keeps the User model lean.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'attendance_term_rollup_studentId_fkey') THEN
    ALTER TABLE "attendance_term_rollup" ADD CONSTRAINT "attendance_term_rollup_studentId_fkey"
      FOREIGN KEY ("studentId") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
END $$;
