-- =============================================================================
-- Exam console: halls come from the room registry, paper sittings know their class
-- =============================================================================
-- Two nullable columns on exam_sitting. No new table, so no new RLS file — both
-- ride exam_sitting's existing tenant policies (prisma/rls/87).
--
--   roomId  — the hall picked from the school's `room` registry. `hall` stays as
--             the stored LABEL so a past sitting still reads honestly after a room
--             is renamed or deleted, and so ad-hoc venues remain expressible.
--             Having the id is what lets capacity come from the registry instead
--             of being retyped per sitting, which is where "Hall A" / "hall A" /
--             "Main Hall" fragmentation came from.
--
--   classId — the class sitting the exam. A CBT-backed sitting reads its roster
--             off the exam's own classId, but a PAPER sitting has no exam, so
--             there was nothing to auto-seat FROM and every paper hall had to be
--             seated by hand, one class per dropdown.
--
-- ON DELETE SET NULL on both: losing a room or a class must never delete exam
-- history. This is deliberately looser than the RESTRICT used for schoolId, where
-- the row genuinely cannot exist without its tenant.
--
-- IF NOT EXISTS / guarded ADD CONSTRAINT throughout: an index- or column-only
-- migration that fails blocks every later migration and takes the API down on
-- boot (PR #21), so it must be safe to re-run.
-- =============================================================================

ALTER TABLE "exam_sitting" ADD COLUMN IF NOT EXISTS "roomId"  UUID;
ALTER TABLE "exam_sitting" ADD COLUMN IF NOT EXISTS "classId" UUID;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'exam_sitting_roomId_fkey') THEN
    ALTER TABLE "exam_sitting" ADD CONSTRAINT "exam_sitting_roomId_fkey"
      FOREIGN KEY ("roomId") REFERENCES "room"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'exam_sitting_classId_fkey') THEN
    ALTER TABLE "exam_sitting" ADD CONSTRAINT "exam_sitting_classId_fkey"
      FOREIGN KEY ("classId") REFERENCES "class"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;

-- No new index. The hall-clash check reads one DAY's sittings, already served by
-- exam_sitting(schoolId, date); the invigilator-clash check is served by
-- exam_invigilator(schoolId, staffId). Both verified present before writing this.
