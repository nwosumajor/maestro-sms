-- Which part of the school raised each charge.
--
-- Hostel rent, transport fares, library fines and tuition all land on the same
-- line-item table — deliberately, so a family gets ONE bill. The cost was that
-- "what did boarding bring in?" had no answer, and the only thing resembling
-- one was the line's `description`, which is operator-supplied free text
-- (`input.description ?? "Hostel rent"`). Attributing money by it would have
-- drifted silently as schools worded their own fee runs.
--
-- NULLABLE on purpose: rows written before this cannot say what they were, and
-- guessing would put invented figures into a finance report.
ALTER TABLE "invoice_line_item" ADD COLUMN "source" TEXT;

-- The report groups by source within a school. Partial: unattributed history
-- is read as one bucket and never filtered on.
CREATE INDEX "invoice_line_item_schoolId_source_idx"
  ON "invoice_line_item" ("schoolId", "source")
  WHERE "source" IS NOT NULL;
