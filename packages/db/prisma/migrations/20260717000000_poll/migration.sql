-- Polling System: polls, options, anonymous votes. Tenant-scoped. RLS in prisma/rls/40.
CREATE TABLE "poll" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "schoolId" UUID NOT NULL,
  "question" TEXT NOT NULL,
  "audience" TEXT NOT NULL DEFAULT 'ALL',
  "createdById" UUID NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'OPEN',
  "closesAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "poll_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "poll_schoolId_idx" ON "poll"("schoolId");

CREATE TABLE "poll_option" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "schoolId" UUID NOT NULL,
  "pollId" UUID NOT NULL,
  "label" TEXT NOT NULL,
  "sequence" INTEGER NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "poll_option_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "poll_option_schoolId_idx" ON "poll_option"("schoolId");
CREATE INDEX "poll_option_schoolId_pollId_idx" ON "poll_option"("schoolId", "pollId");

CREATE TABLE "poll_vote" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "schoolId" UUID NOT NULL,
  "pollId" UUID NOT NULL,
  "optionId" UUID NOT NULL,
  "voterId" UUID NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "poll_vote_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "poll_vote_pollId_voterId_key" ON "poll_vote"("pollId", "voterId");
CREATE INDEX "poll_vote_schoolId_idx" ON "poll_vote"("schoolId");
CREATE INDEX "poll_vote_optionId_idx" ON "poll_vote"("optionId");

ALTER TABLE "poll_option" ADD CONSTRAINT "poll_option_pollId_fkey"
  FOREIGN KEY ("pollId") REFERENCES "poll"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "poll_vote" ADD CONSTRAINT "poll_vote_pollId_fkey"
  FOREIGN KEY ("pollId") REFERENCES "poll"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "poll_vote" ADD CONSTRAINT "poll_vote_optionId_fkey"
  FOREIGN KEY ("optionId") REFERENCES "poll_option"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
