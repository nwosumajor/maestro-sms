-- Discussion Hub: groups, posts, comments. Tenant-scoped. RLS in prisma/rls/41.
CREATE TABLE "discussion_group" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "schoolId" UUID NOT NULL, "name" TEXT NOT NULL, "description" TEXT,
  "audience" TEXT NOT NULL DEFAULT 'ALL', "createdById" UUID NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "discussion_group_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "discussion_group_schoolId_idx" ON "discussion_group"("schoolId");
CREATE TABLE "discussion_post" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "schoolId" UUID NOT NULL, "groupId" UUID NOT NULL, "authorId" UUID NOT NULL,
  "body" TEXT NOT NULL, "deleted" BOOLEAN NOT NULL DEFAULT false,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "discussion_post_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "discussion_post_schoolId_idx" ON "discussion_post"("schoolId");
CREATE INDEX "discussion_post_schoolId_groupId_idx" ON "discussion_post"("schoolId", "groupId");
CREATE TABLE "discussion_comment" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "schoolId" UUID NOT NULL, "postId" UUID NOT NULL, "authorId" UUID NOT NULL,
  "body" TEXT NOT NULL, "deleted" BOOLEAN NOT NULL DEFAULT false,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "discussion_comment_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "discussion_comment_schoolId_idx" ON "discussion_comment"("schoolId");
CREATE INDEX "discussion_comment_postId_idx" ON "discussion_comment"("postId");
ALTER TABLE "discussion_post" ADD CONSTRAINT "discussion_post_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "discussion_group"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "discussion_comment" ADD CONSTRAINT "discussion_comment_postId_fkey" FOREIGN KEY ("postId") REFERENCES "discussion_post"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
