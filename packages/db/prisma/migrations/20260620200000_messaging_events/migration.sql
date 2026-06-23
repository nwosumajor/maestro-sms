-- Messaging (threads + participants + append-only messages) and Calendar events.
-- RLS in prisma/rls/15_messaging_events_rls.sql.

-- CreateEnum
CREATE TYPE "EventAudience" AS ENUM ('ALL', 'STAFF');

-- CreateTable
CREATE TABLE "message_thread" (
    "id" UUID NOT NULL,
    "schoolId" UUID NOT NULL,
    "subject" TEXT NOT NULL,
    "createdById" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "message_thread_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "thread_participant" (
    "id" UUID NOT NULL,
    "schoolId" UUID NOT NULL,
    "threadId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "lastReadAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "thread_participant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "message" (
    "id" UUID NOT NULL,
    "schoolId" UUID NOT NULL,
    "threadId" UUID NOT NULL,
    "senderId" UUID NOT NULL,
    "body" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "message_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "school_event" (
    "id" UUID NOT NULL,
    "schoolId" UUID NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "startsAt" TIMESTAMP(3) NOT NULL,
    "endsAt" TIMESTAMP(3),
    "allDay" BOOLEAN NOT NULL DEFAULT false,
    "audience" "EventAudience" NOT NULL DEFAULT 'ALL',
    "createdById" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "school_event_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "message_thread_schoolId_idx" ON "message_thread"("schoolId");
CREATE UNIQUE INDEX "thread_participant_threadId_userId_key" ON "thread_participant"("threadId", "userId");
CREATE INDEX "thread_participant_schoolId_idx" ON "thread_participant"("schoolId");
CREATE INDEX "thread_participant_schoolId_userId_idx" ON "thread_participant"("schoolId", "userId");
CREATE INDEX "message_schoolId_idx" ON "message"("schoolId");
CREATE INDEX "message_schoolId_threadId_idx" ON "message"("schoolId", "threadId");
CREATE INDEX "school_event_schoolId_idx" ON "school_event"("schoolId");
CREATE INDEX "school_event_schoolId_startsAt_idx" ON "school_event"("schoolId", "startsAt");

-- AddForeignKey
ALTER TABLE "message_thread" ADD CONSTRAINT "message_thread_schoolId_fkey" FOREIGN KEY ("schoolId") REFERENCES "school"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "thread_participant" ADD CONSTRAINT "thread_participant_schoolId_fkey" FOREIGN KEY ("schoolId") REFERENCES "school"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "thread_participant" ADD CONSTRAINT "thread_participant_threadId_fkey" FOREIGN KEY ("threadId") REFERENCES "message_thread"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "message" ADD CONSTRAINT "message_schoolId_fkey" FOREIGN KEY ("schoolId") REFERENCES "school"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "message" ADD CONSTRAINT "message_threadId_fkey" FOREIGN KEY ("threadId") REFERENCES "message_thread"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "school_event" ADD CONSTRAINT "school_event_schoolId_fkey" FOREIGN KEY ("schoolId") REFERENCES "school"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
