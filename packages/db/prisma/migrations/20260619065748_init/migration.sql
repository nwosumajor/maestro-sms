-- CreateEnum
CREATE TYPE "SubmissionContentKind" AS ENUM ('PROSE', 'CODE');

-- CreateEnum
CREATE TYPE "SubmissionStatus" AS ENUM ('IN_PROGRESS', 'SUBMITTED');

-- CreateEnum
CREATE TYPE "IntegritySignalSource" AS ENUM ('CLIENT', 'SERVER');

-- CreateEnum
CREATE TYPE "IntegritySignalType" AS ENUM ('PASTE', 'FOCUS_LOSS', 'TYPING_ANOMALY', 'SIMILARITY', 'DRAFT_ANOMALY');

-- CreateEnum
CREATE TYPE "IntegritySignalSeverity" AS ENUM ('INFO', 'LOW', 'MEDIUM', 'HIGH');

-- CreateTable
CREATE TABLE "school" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "school_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user" (
    "id" UUID NOT NULL,
    "schoolId" UUID NOT NULL,
    "email" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "user_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "role" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,

    CONSTRAINT "role_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "permission" (
    "id" UUID NOT NULL,
    "key" TEXT NOT NULL,

    CONSTRAINT "permission_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "role_permission" (
    "roleId" UUID NOT NULL,
    "permissionId" UUID NOT NULL,

    CONSTRAINT "role_permission_pkey" PRIMARY KEY ("roleId","permissionId")
);

-- CreateTable
CREATE TABLE "user_role" (
    "id" UUID NOT NULL,
    "schoolId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "roleId" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "user_role_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_log" (
    "id" UUID NOT NULL,
    "schoolId" UUID NOT NULL,
    "actorId" UUID NOT NULL,
    "action" TEXT NOT NULL,
    "entity" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_log_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "integrity_consent" (
    "id" UUID NOT NULL,
    "schoolId" UUID NOT NULL,
    "studentId" UUID NOT NULL,
    "grantedById" UUID NOT NULL,
    "grantedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revokedAt" TIMESTAMP(3),
    "revokedById" UUID,

    CONSTRAINT "integrity_consent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "assessment" (
    "id" UUID NOT NULL,
    "schoolId" UUID NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "createdById" UUID NOT NULL,
    "classId" UUID,
    "pasteBlocked" BOOLEAN NOT NULL DEFAULT false,
    "focusTracked" BOOLEAN NOT NULL DEFAULT false,
    "typingTracked" BOOLEAN NOT NULL DEFAULT false,
    "integrityEnabled" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "assessment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "submission" (
    "id" UUID NOT NULL,
    "schoolId" UUID NOT NULL,
    "assessmentId" UUID NOT NULL,
    "studentId" UUID NOT NULL,
    "status" "SubmissionStatus" NOT NULL DEFAULT 'IN_PROGRESS',
    "contentKind" "SubmissionContentKind" NOT NULL DEFAULT 'PROSE',
    "content" TEXT,
    "submittedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "submission_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "submission_draft" (
    "id" UUID NOT NULL,
    "schoolId" UUID NOT NULL,
    "submissionId" UUID NOT NULL,
    "sequence" INTEGER NOT NULL,
    "contentHash" TEXT NOT NULL,
    "content" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "submission_draft_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "integrity_signal" (
    "id" UUID NOT NULL,
    "schoolId" UUID NOT NULL,
    "submissionId" UUID NOT NULL,
    "type" "IntegritySignalType" NOT NULL,
    "severity" "IntegritySignalSeverity" NOT NULL,
    "source" "IntegritySignalSource" NOT NULL,
    "confidence" DOUBLE PRECISION NOT NULL,
    "evidence" JSONB NOT NULL,
    "detector" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "integrity_signal_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "submission_telemetry" (
    "id" UUID NOT NULL,
    "schoolId" UUID NOT NULL,
    "submissionId" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "submission_telemetry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "student_integrity_exemption" (
    "id" UUID NOT NULL,
    "schoolId" UUID NOT NULL,
    "studentId" UUID NOT NULL,
    "assessmentId" UUID,
    "reason" TEXT NOT NULL,
    "grantedById" UUID NOT NULL,
    "revokedAt" TIMESTAMP(3),
    "revokedById" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "student_integrity_exemption_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "class" (
    "id" UUID NOT NULL,
    "schoolId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "subject" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "class_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "class_teacher" (
    "id" UUID NOT NULL,
    "schoolId" UUID NOT NULL,
    "classId" UUID NOT NULL,
    "teacherId" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "class_teacher_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "enrollment" (
    "id" UUID NOT NULL,
    "schoolId" UUID NOT NULL,
    "classId" UUID NOT NULL,
    "studentId" UUID NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "enrolledAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "enrollment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "parent_child" (
    "id" UUID NOT NULL,
    "schoolId" UUID NOT NULL,
    "parentId" UUID NOT NULL,
    "studentId" UUID NOT NULL,
    "relationship" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "parent_child_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "school_slug_key" ON "school"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "user_email_key" ON "user"("email");

-- CreateIndex
CREATE INDEX "user_schoolId_idx" ON "user"("schoolId");

-- CreateIndex
CREATE UNIQUE INDEX "role_name_key" ON "role"("name");

-- CreateIndex
CREATE UNIQUE INDEX "permission_key_key" ON "permission"("key");

-- CreateIndex
CREATE INDEX "user_role_schoolId_idx" ON "user_role"("schoolId");

-- CreateIndex
CREATE UNIQUE INDEX "user_role_userId_roleId_key" ON "user_role"("userId", "roleId");

-- CreateIndex
CREATE INDEX "audit_log_schoolId_idx" ON "audit_log"("schoolId");

-- CreateIndex
CREATE INDEX "audit_log_schoolId_entity_entityId_idx" ON "audit_log"("schoolId", "entity", "entityId");

-- CreateIndex
CREATE INDEX "audit_log_schoolId_createdAt_idx" ON "audit_log"("schoolId", "createdAt");

-- CreateIndex
CREATE INDEX "integrity_consent_schoolId_studentId_idx" ON "integrity_consent"("schoolId", "studentId");

-- CreateIndex
CREATE INDEX "assessment_schoolId_idx" ON "assessment"("schoolId");

-- CreateIndex
CREATE INDEX "assessment_schoolId_createdById_idx" ON "assessment"("schoolId", "createdById");

-- CreateIndex
CREATE INDEX "submission_schoolId_idx" ON "submission"("schoolId");

-- CreateIndex
CREATE INDEX "submission_schoolId_assessmentId_idx" ON "submission"("schoolId", "assessmentId");

-- CreateIndex
CREATE UNIQUE INDEX "submission_assessmentId_studentId_key" ON "submission"("assessmentId", "studentId");

-- CreateIndex
CREATE INDEX "submission_draft_schoolId_idx" ON "submission_draft"("schoolId");

-- CreateIndex
CREATE INDEX "submission_draft_schoolId_submissionId_idx" ON "submission_draft"("schoolId", "submissionId");

-- CreateIndex
CREATE UNIQUE INDEX "submission_draft_submissionId_sequence_key" ON "submission_draft"("submissionId", "sequence");

-- CreateIndex
CREATE INDEX "integrity_signal_schoolId_idx" ON "integrity_signal"("schoolId");

-- CreateIndex
CREATE INDEX "integrity_signal_schoolId_submissionId_idx" ON "integrity_signal"("schoolId", "submissionId");

-- CreateIndex
CREATE INDEX "integrity_signal_schoolId_submissionId_type_idx" ON "integrity_signal"("schoolId", "submissionId", "type");

-- CreateIndex
CREATE INDEX "submission_telemetry_schoolId_idx" ON "submission_telemetry"("schoolId");

-- CreateIndex
CREATE INDEX "submission_telemetry_schoolId_submissionId_idx" ON "submission_telemetry"("schoolId", "submissionId");

-- CreateIndex
CREATE INDEX "submission_telemetry_schoolId_submissionId_kind_idx" ON "submission_telemetry"("schoolId", "submissionId", "kind");

-- CreateIndex
CREATE INDEX "student_integrity_exemption_schoolId_idx" ON "student_integrity_exemption"("schoolId");

-- CreateIndex
CREATE INDEX "student_integrity_exemption_schoolId_studentId_idx" ON "student_integrity_exemption"("schoolId", "studentId");

-- CreateIndex
CREATE INDEX "student_integrity_exemption_schoolId_studentId_assessmentId_idx" ON "student_integrity_exemption"("schoolId", "studentId", "assessmentId");

-- CreateIndex
CREATE INDEX "class_schoolId_idx" ON "class"("schoolId");

-- CreateIndex
CREATE INDEX "class_teacher_schoolId_idx" ON "class_teacher"("schoolId");

-- CreateIndex
CREATE INDEX "class_teacher_schoolId_teacherId_idx" ON "class_teacher"("schoolId", "teacherId");

-- CreateIndex
CREATE UNIQUE INDEX "class_teacher_classId_teacherId_key" ON "class_teacher"("classId", "teacherId");

-- CreateIndex
CREATE INDEX "enrollment_schoolId_idx" ON "enrollment"("schoolId");

-- CreateIndex
CREATE INDEX "enrollment_schoolId_studentId_idx" ON "enrollment"("schoolId", "studentId");

-- CreateIndex
CREATE UNIQUE INDEX "enrollment_classId_studentId_key" ON "enrollment"("classId", "studentId");

-- CreateIndex
CREATE INDEX "parent_child_schoolId_idx" ON "parent_child"("schoolId");

-- CreateIndex
CREATE INDEX "parent_child_schoolId_parentId_idx" ON "parent_child"("schoolId", "parentId");

-- CreateIndex
CREATE UNIQUE INDEX "parent_child_parentId_studentId_key" ON "parent_child"("parentId", "studentId");

-- AddForeignKey
ALTER TABLE "user" ADD CONSTRAINT "user_schoolId_fkey" FOREIGN KEY ("schoolId") REFERENCES "school"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "role_permission" ADD CONSTRAINT "role_permission_roleId_fkey" FOREIGN KEY ("roleId") REFERENCES "role"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "role_permission" ADD CONSTRAINT "role_permission_permissionId_fkey" FOREIGN KEY ("permissionId") REFERENCES "permission"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_role" ADD CONSTRAINT "user_role_schoolId_fkey" FOREIGN KEY ("schoolId") REFERENCES "school"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_role" ADD CONSTRAINT "user_role_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_role" ADD CONSTRAINT "user_role_roleId_fkey" FOREIGN KEY ("roleId") REFERENCES "role"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_schoolId_fkey" FOREIGN KEY ("schoolId") REFERENCES "school"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "integrity_consent" ADD CONSTRAINT "integrity_consent_schoolId_fkey" FOREIGN KEY ("schoolId") REFERENCES "school"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "integrity_consent" ADD CONSTRAINT "integrity_consent_studentId_fkey" FOREIGN KEY ("studentId") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "integrity_consent" ADD CONSTRAINT "integrity_consent_grantedById_fkey" FOREIGN KEY ("grantedById") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "integrity_consent" ADD CONSTRAINT "integrity_consent_revokedById_fkey" FOREIGN KEY ("revokedById") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "assessment" ADD CONSTRAINT "assessment_schoolId_fkey" FOREIGN KEY ("schoolId") REFERENCES "school"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "assessment" ADD CONSTRAINT "assessment_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "assessment" ADD CONSTRAINT "assessment_classId_fkey" FOREIGN KEY ("classId") REFERENCES "class"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "submission" ADD CONSTRAINT "submission_schoolId_fkey" FOREIGN KEY ("schoolId") REFERENCES "school"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "submission" ADD CONSTRAINT "submission_studentId_fkey" FOREIGN KEY ("studentId") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "submission" ADD CONSTRAINT "submission_assessmentId_fkey" FOREIGN KEY ("assessmentId") REFERENCES "assessment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "submission_draft" ADD CONSTRAINT "submission_draft_schoolId_fkey" FOREIGN KEY ("schoolId") REFERENCES "school"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "submission_draft" ADD CONSTRAINT "submission_draft_submissionId_fkey" FOREIGN KEY ("submissionId") REFERENCES "submission"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "integrity_signal" ADD CONSTRAINT "integrity_signal_schoolId_fkey" FOREIGN KEY ("schoolId") REFERENCES "school"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "integrity_signal" ADD CONSTRAINT "integrity_signal_submissionId_fkey" FOREIGN KEY ("submissionId") REFERENCES "submission"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "submission_telemetry" ADD CONSTRAINT "submission_telemetry_schoolId_fkey" FOREIGN KEY ("schoolId") REFERENCES "school"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "submission_telemetry" ADD CONSTRAINT "submission_telemetry_submissionId_fkey" FOREIGN KEY ("submissionId") REFERENCES "submission"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "student_integrity_exemption" ADD CONSTRAINT "student_integrity_exemption_schoolId_fkey" FOREIGN KEY ("schoolId") REFERENCES "school"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "student_integrity_exemption" ADD CONSTRAINT "student_integrity_exemption_studentId_fkey" FOREIGN KEY ("studentId") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "student_integrity_exemption" ADD CONSTRAINT "student_integrity_exemption_grantedById_fkey" FOREIGN KEY ("grantedById") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "student_integrity_exemption" ADD CONSTRAINT "student_integrity_exemption_revokedById_fkey" FOREIGN KEY ("revokedById") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "student_integrity_exemption" ADD CONSTRAINT "student_integrity_exemption_assessmentId_fkey" FOREIGN KEY ("assessmentId") REFERENCES "assessment"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "class" ADD CONSTRAINT "class_schoolId_fkey" FOREIGN KEY ("schoolId") REFERENCES "school"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "class_teacher" ADD CONSTRAINT "class_teacher_schoolId_fkey" FOREIGN KEY ("schoolId") REFERENCES "school"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "class_teacher" ADD CONSTRAINT "class_teacher_classId_fkey" FOREIGN KEY ("classId") REFERENCES "class"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "class_teacher" ADD CONSTRAINT "class_teacher_teacherId_fkey" FOREIGN KEY ("teacherId") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "enrollment" ADD CONSTRAINT "enrollment_schoolId_fkey" FOREIGN KEY ("schoolId") REFERENCES "school"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "enrollment" ADD CONSTRAINT "enrollment_classId_fkey" FOREIGN KEY ("classId") REFERENCES "class"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "enrollment" ADD CONSTRAINT "enrollment_studentId_fkey" FOREIGN KEY ("studentId") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "parent_child" ADD CONSTRAINT "parent_child_schoolId_fkey" FOREIGN KEY ("schoolId") REFERENCES "school"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "parent_child" ADD CONSTRAINT "parent_child_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "parent_child" ADD CONSTRAINT "parent_child_studentId_fkey" FOREIGN KEY ("studentId") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
