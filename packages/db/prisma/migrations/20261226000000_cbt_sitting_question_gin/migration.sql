-- Answering "has any candidate been served this question?" ------------------
--
-- Editing or deleting a question in a bank has to know whether it is already
-- part of somebody's sat paper. Each sitting stores the exact paper it was
-- served as a jsonb array of question ids, so the question is a containment
-- test — and without an index that is a sequential scan of every sitting.
--
-- Measured on 20,002 sittings: 14.6 ms as a Seq Scan, 0.43 ms as a Bitmap Index
-- Scan, and the scan grows with the table while the index does not. A school
-- accumulates sittings for as long as it uses the module.
--
-- jsonb_path_ops rather than the default: it indexes only the values, which is
-- all `@>` needs here, and produces a smaller index than jsonb_ops.
CREATE INDEX IF NOT EXISTS "cbt_sitting_questionIds_gin"
  ON "cbt_sitting" USING GIN ("questionIds" jsonb_path_ops);
