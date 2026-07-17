-- Multi-school group console: global group registry + members + directors
-- (posture in rls/74_group_rls.sql — app role deny-all; privileged reads only).

CREATE TABLE "school_group" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "school_group_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "school_group_member" (
    "id" UUID NOT NULL,
    "groupId" UUID NOT NULL,
    "schoolId" UUID NOT NULL,
    CONSTRAINT "school_group_member_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "school_group_member_groupId_schoolId_key" ON "school_group_member"("groupId", "schoolId");
ALTER TABLE "school_group_member" ADD CONSTRAINT "school_group_member_groupId_fkey"
    FOREIGN KEY ("groupId") REFERENCES "school_group"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "school_group_director" (
    "id" UUID NOT NULL,
    "groupId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    CONSTRAINT "school_group_director_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "school_group_director_groupId_userId_key" ON "school_group_director"("groupId", "userId");
CREATE INDEX "school_group_director_userId_idx" ON "school_group_director"("userId");
ALTER TABLE "school_group_director" ADD CONSTRAINT "school_group_director_groupId_fkey"
    FOREIGN KEY ("groupId") REFERENCES "school_group"("id") ON DELETE CASCADE ON UPDATE CASCADE;
