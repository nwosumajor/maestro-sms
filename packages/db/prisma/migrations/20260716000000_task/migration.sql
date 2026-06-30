-- Task System: tasks, per-assignee assignments, follow-up comments. Tenant-scoped.
-- RLS applied separately (prisma/rls/39).
CREATE TABLE "task" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "schoolId" UUID NOT NULL,
  "title" TEXT NOT NULL,
  "description" TEXT,
  "createdById" UUID NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'OPEN',
  "dueAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "task_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "task_schoolId_idx" ON "task"("schoolId");
CREATE INDEX "task_schoolId_createdById_idx" ON "task"("schoolId", "createdById");

CREATE TABLE "task_assignment" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "schoolId" UUID NOT NULL,
  "taskId" UUID NOT NULL,
  "assigneeId" UUID NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'ASSIGNED',
  "note" TEXT,
  "attachmentKey" TEXT,
  "attachmentName" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "task_assignment_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "task_assignment_taskId_assigneeId_key" ON "task_assignment"("taskId", "assigneeId");
CREATE INDEX "task_assignment_schoolId_idx" ON "task_assignment"("schoolId");
CREATE INDEX "task_assignment_schoolId_assigneeId_idx" ON "task_assignment"("schoolId", "assigneeId");

CREATE TABLE "task_comment" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "schoolId" UUID NOT NULL,
  "taskId" UUID NOT NULL,
  "authorId" UUID NOT NULL,
  "body" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "task_comment_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "task_comment_schoolId_idx" ON "task_comment"("schoolId");
CREATE INDEX "task_comment_taskId_idx" ON "task_comment"("taskId");

ALTER TABLE "task_assignment" ADD CONSTRAINT "task_assignment_taskId_fkey"
  FOREIGN KEY ("taskId") REFERENCES "task"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "task_comment" ADD CONSTRAINT "task_comment_taskId_fkey"
  FOREIGN KEY ("taskId") REFERENCES "task"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
