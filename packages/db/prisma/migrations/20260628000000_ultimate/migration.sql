-- Dead & Wounded Ultimate (cross-school) arena (spec §7/§10, step 8).
-- (A) ultimate_competition / ultimate_participant are CROSS-TENANT, RLS-EXEMPT
--     (see 21_ultimate_rls.sql) — they carry only opaque ids, handles, schoolId
--     (grouping), the server-only secret, and scores. NO userId / PII.
-- (B) ultimate_enrollment / ultimate_consent / ultimate_entry_link are
--     TENANT-SCOPED (RLS); ultimate_entry_link is the only userId<->participant map.
CREATE TYPE "UltimateStatus" AS ENUM ('DRAFT', 'ACTIVE', 'FINISHED', 'CANCELLED');
CREATE TYPE "UltimateParticipantStatus" AS ENUM ('ACTIVE', 'FINISHED');

CREATE TABLE "ultimate_competition" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "difficultyLength" INTEGER NOT NULL,
    "status" "UltimateStatus" NOT NULL DEFAULT 'ACTIVE',
    "startAt" TIMESTAMP(3) NOT NULL,
    "endAt" TIMESTAMP(3) NOT NULL,
    "createdById" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "ultimate_competition_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ultimate_participant" (
    "id" UUID NOT NULL,
    "competitionId" UUID NOT NULL,
    "schoolId" UUID NOT NULL,
    "handle" TEXT NOT NULL,
    "secret" TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "guessCount" INTEGER NOT NULL DEFAULT 0,
    "lastGuessAt" TIMESTAMP(3),
    "elapsedMs" INTEGER,
    "finishedAt" TIMESTAMP(3),
    "status" "UltimateParticipantStatus" NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "ultimate_participant_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "ultimate_participant_competitionId_idx" ON "ultimate_participant"("competitionId");
CREATE INDEX "ultimate_participant_competitionId_schoolId_idx" ON "ultimate_participant"("competitionId", "schoolId");

CREATE TABLE "ultimate_enrollment" (
    "id" UUID NOT NULL,
    "schoolId" UUID NOT NULL,
    "competitionId" UUID NOT NULL,
    "enrolledById" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ultimate_enrollment_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "ultimate_enrollment_schoolId_competitionId_key" ON "ultimate_enrollment"("schoolId", "competitionId");
CREATE INDEX "ultimate_enrollment_schoolId_idx" ON "ultimate_enrollment"("schoolId");

CREATE TABLE "ultimate_consent" (
    "id" UUID NOT NULL,
    "schoolId" UUID NOT NULL,
    "studentId" UUID NOT NULL,
    "granted" BOOLEAN NOT NULL DEFAULT false,
    "grantedById" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "ultimate_consent_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "ultimate_consent_schoolId_studentId_key" ON "ultimate_consent"("schoolId", "studentId");
CREATE INDEX "ultimate_consent_schoolId_idx" ON "ultimate_consent"("schoolId");

CREATE TABLE "ultimate_entry_link" (
    "id" UUID NOT NULL,
    "schoolId" UUID NOT NULL,
    "competitionId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "participantId" UUID NOT NULL,
    "handle" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ultimate_entry_link_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "ultimate_entry_link_competitionId_userId_key" ON "ultimate_entry_link"("competitionId", "userId");
CREATE INDEX "ultimate_entry_link_schoolId_idx" ON "ultimate_entry_link"("schoolId");

-- Arena FKs (cross-tenant): participant → competition; participant.schoolId →
-- school is a DB-integrity FK only (scalar in Prisma; no tenant relation).
ALTER TABLE "ultimate_participant" ADD CONSTRAINT "ultimate_participant_competitionId_fkey" FOREIGN KEY ("competitionId") REFERENCES "ultimate_competition"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ultimate_participant" ADD CONSTRAINT "ultimate_participant_schoolId_fkey" FOREIGN KEY ("schoolId") REFERENCES "school"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Tenant bridge/governance FKs.
ALTER TABLE "ultimate_enrollment" ADD CONSTRAINT "ultimate_enrollment_schoolId_fkey" FOREIGN KEY ("schoolId") REFERENCES "school"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ultimate_enrollment" ADD CONSTRAINT "ultimate_enrollment_competitionId_fkey" FOREIGN KEY ("competitionId") REFERENCES "ultimate_competition"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ultimate_consent" ADD CONSTRAINT "ultimate_consent_schoolId_fkey" FOREIGN KEY ("schoolId") REFERENCES "school"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ultimate_consent" ADD CONSTRAINT "ultimate_consent_studentId_fkey" FOREIGN KEY ("studentId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ultimate_entry_link" ADD CONSTRAINT "ultimate_entry_link_schoolId_fkey" FOREIGN KEY ("schoolId") REFERENCES "school"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ultimate_entry_link" ADD CONSTRAINT "ultimate_entry_link_competitionId_fkey" FOREIGN KEY ("competitionId") REFERENCES "ultimate_competition"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ultimate_entry_link" ADD CONSTRAINT "ultimate_entry_link_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ultimate_entry_link" ADD CONSTRAINT "ultimate_entry_link_participantId_fkey" FOREIGN KEY ("participantId") REFERENCES "ultimate_participant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
