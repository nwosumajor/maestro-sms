-- Live Quiz editing: soft-delete flag (archive). The DELETE policy + grant that
-- lets a host REPLACE a quiz's questions on edit is applied separately in
-- packages/db/prisma/rls/66_live_quiz_question_delete.sql (RLS lives outside
-- migrations, per repo convention).

ALTER TABLE "live_quiz" ADD COLUMN "archived" BOOLEAN NOT NULL DEFAULT false;
