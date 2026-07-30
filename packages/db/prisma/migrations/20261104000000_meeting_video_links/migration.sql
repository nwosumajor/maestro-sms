-- =============================================================================
-- Video-meeting links on parent-teacher slots and calendar (staff) events
-- =============================================================================
-- LMS live classes already carried a validated Zoom/Meet/Jitsi join URL, but the
-- two MEETING surfaces had no video capability at all:
--   * meeting_slot had only a free-text `location`, so a video call meant pasting
--     a URL into an unvalidated, un-gated field;
--   * school_event (which carries STAFF-audience meetings) had no link field.
--
-- Both now take the same pair the LMS uses. `provider` names the platform
-- (ZOOM | MEET | TEAMS | JITSI | OTHER) and `joinUrl` is validated server-side
-- (https only + per-provider host allowlist) before it is ever stored, so a
-- "Teams" meeting cannot point at another domain. Both are NULLABLE — an
-- in-person meeting simply has neither.
-- =============================================================================

ALTER TABLE "meeting_slot" ADD COLUMN "provider" TEXT;
ALTER TABLE "meeting_slot" ADD COLUMN "joinUrl"  TEXT;

ALTER TABLE "school_event" ADD COLUMN "provider" TEXT;
ALTER TABLE "school_event" ADD COLUMN "joinUrl"  TEXT;
