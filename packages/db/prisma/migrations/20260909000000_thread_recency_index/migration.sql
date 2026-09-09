-- A messaging inbox is ordered by LAST ACTIVITY, so it needs the index for that
-- ordering — the existing one is (schoolId, createdAt DESC, id DESC), which is
-- why the list sorted by createdAt and a reply never moved a conversation.
-- Same shape, on the column the list actually orders by.
CREATE INDEX "message_thread_schoolId_updatedAt_id_idx"
  ON "message_thread" ("schoolId", "updatedAt" DESC, "id" DESC);
