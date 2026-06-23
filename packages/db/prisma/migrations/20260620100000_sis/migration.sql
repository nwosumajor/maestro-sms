-- SIS: student contact profile + emergency contacts + (sensitive) medical record.
-- RLS for these tables is applied SEPARATELY in prisma/rls/07_sis_rls.sql.

-- CreateTable
CREATE TABLE "student_profile" (
    "id" UUID NOT NULL,
    "schoolId" UUID NOT NULL,
    "studentId" UUID NOT NULL,
    "admissionNumber" TEXT,
    "dateOfBirth" DATE,
    "gender" TEXT,
    "phone" TEXT,
    "email" TEXT,
    "addressLine1" TEXT,
    "addressLine2" TEXT,
    "city" TEXT,
    "state" TEXT,
    "country" TEXT,
    "postalCode" TEXT,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "student_profile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "emergency_contact" (
    "id" UUID NOT NULL,
    "schoolId" UUID NOT NULL,
    "profileId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "relationship" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "email" TEXT,
    "priority" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "emergency_contact_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "medical_record" (
    "id" UUID NOT NULL,
    "schoolId" UUID NOT NULL,
    "profileId" UUID NOT NULL,
    "bloodGroup" TEXT,
    "allergies" TEXT,
    "conditions" TEXT,
    "medications" TEXT,
    "dietaryNotes" TEXT,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "medical_record_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "student_profile_studentId_key" ON "student_profile"("studentId");
CREATE INDEX "student_profile_schoolId_idx" ON "student_profile"("schoolId");
CREATE INDEX "student_profile_schoolId_studentId_idx" ON "student_profile"("schoolId", "studentId");

-- CreateIndex
CREATE INDEX "emergency_contact_schoolId_idx" ON "emergency_contact"("schoolId");
CREATE INDEX "emergency_contact_schoolId_profileId_idx" ON "emergency_contact"("schoolId", "profileId");

-- CreateIndex
CREATE UNIQUE INDEX "medical_record_profileId_key" ON "medical_record"("profileId");
CREATE INDEX "medical_record_schoolId_idx" ON "medical_record"("schoolId");
CREATE INDEX "medical_record_schoolId_profileId_idx" ON "medical_record"("schoolId", "profileId");

-- AddForeignKey
ALTER TABLE "student_profile" ADD CONSTRAINT "student_profile_schoolId_fkey" FOREIGN KEY ("schoolId") REFERENCES "school"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "student_profile" ADD CONSTRAINT "student_profile_studentId_fkey" FOREIGN KEY ("studentId") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "emergency_contact" ADD CONSTRAINT "emergency_contact_schoolId_fkey" FOREIGN KEY ("schoolId") REFERENCES "school"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "emergency_contact" ADD CONSTRAINT "emergency_contact_profileId_fkey" FOREIGN KEY ("profileId") REFERENCES "student_profile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "medical_record" ADD CONSTRAINT "medical_record_schoolId_fkey" FOREIGN KEY ("schoolId") REFERENCES "school"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "medical_record" ADD CONSTRAINT "medical_record_profileId_fkey" FOREIGN KEY ("profileId") REFERENCES "student_profile"("id") ON DELETE CASCADE ON UPDATE CASCADE;
