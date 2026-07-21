-- Physical exam logistics: sittings, seating plans, invigilation.

CREATE TABLE "exam_sitting" (
    "id" UUID NOT NULL,
    "schoolId" UUID NOT NULL,
    "title" TEXT NOT NULL,
    "subject" TEXT,
    "date" DATE NOT NULL,
    "startsAt" TEXT NOT NULL,
    "endsAt" TEXT NOT NULL,
    "hall" TEXT NOT NULL,
    "capacity" INTEGER NOT NULL DEFAULT 0,
    "note" TEXT,
    "createdById" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "exam_sitting_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "exam_sitting_schoolId_idx" ON "exam_sitting"("schoolId");
CREATE INDEX "exam_sitting_schoolId_date_idx" ON "exam_sitting"("schoolId", "date");
ALTER TABLE "exam_sitting" ADD CONSTRAINT "exam_sitting_schoolId_fkey" FOREIGN KEY ("schoolId") REFERENCES "school"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "exam_seat" (
    "id" UUID NOT NULL,
    "schoolId" UUID NOT NULL,
    "sittingId" UUID NOT NULL,
    "studentId" UUID NOT NULL,
    "seatNo" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "exam_seat_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "exam_seat_sittingId_studentId_key" ON "exam_seat"("sittingId", "studentId");
CREATE UNIQUE INDEX "exam_seat_sittingId_seatNo_key" ON "exam_seat"("sittingId", "seatNo");
CREATE INDEX "exam_seat_schoolId_idx" ON "exam_seat"("schoolId");
CREATE INDEX "exam_seat_schoolId_studentId_idx" ON "exam_seat"("schoolId", "studentId");
ALTER TABLE "exam_seat" ADD CONSTRAINT "exam_seat_schoolId_fkey" FOREIGN KEY ("schoolId") REFERENCES "school"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "exam_seat" ADD CONSTRAINT "exam_seat_sittingId_fkey" FOREIGN KEY ("sittingId") REFERENCES "exam_sitting"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "exam_invigilator" (
    "id" UUID NOT NULL,
    "schoolId" UUID NOT NULL,
    "sittingId" UUID NOT NULL,
    "staffId" UUID NOT NULL,
    "lead" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "exam_invigilator_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "exam_invigilator_sittingId_staffId_key" ON "exam_invigilator"("sittingId", "staffId");
CREATE INDEX "exam_invigilator_schoolId_idx" ON "exam_invigilator"("schoolId");
CREATE INDEX "exam_invigilator_schoolId_staffId_idx" ON "exam_invigilator"("schoolId", "staffId");
ALTER TABLE "exam_invigilator" ADD CONSTRAINT "exam_invigilator_schoolId_fkey" FOREIGN KEY ("schoolId") REFERENCES "school"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "exam_invigilator" ADD CONSTRAINT "exam_invigilator_sittingId_fkey" FOREIGN KEY ("sittingId") REFERENCES "exam_sitting"("id") ON DELETE CASCADE ON UPDATE CASCADE;
