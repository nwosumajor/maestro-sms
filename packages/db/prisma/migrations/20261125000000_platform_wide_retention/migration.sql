-- Two append-only tables that are NOT about a school's pupils, and so are not
-- governed by that school's privacy window — but which grew without any bound at
-- all until now.
--
-- gateway_event is swept on receivedAt ALONE, deliberately: its schoolId is
-- nullable by documented design (a webhook can arrive before we know which
-- school it belongs to), so a schoolId-scoped delete would leave every unmatched
-- event behind for ever — precisely the set most likely to accumulate. No index
-- served a bare receivedAt filter.
CREATE INDEX IF NOT EXISTS "gateway_event_receivedAt_idx"
  ON "gateway_event" ("receivedAt");

-- lms_content_revision is capped per CONTENT ITEM rather than by age, so the
-- ranking window runs over (contentId, version). The existing
-- (schoolId, contentId) index does not order by version.
CREATE INDEX IF NOT EXISTS "lms_content_revision_contentId_version_idx"
  ON "lms_content_revision" ("contentId", "version" DESC);
