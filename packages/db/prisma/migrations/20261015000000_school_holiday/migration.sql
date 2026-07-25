-- CreateTable
CREATE TABLE "school_holiday" (
    "id" UUID NOT NULL,
    "schoolId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "startDate" DATE NOT NULL,
    "endDate" DATE NOT NULL,
    "createdById" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "school_holiday_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "school_holiday_schoolId_idx" ON "school_holiday"("schoolId");

-- CreateIndex
CREATE INDEX "school_holiday_schoolId_startDate_idx" ON "school_holiday"("schoolId", "startDate");

-- AddForeignKey
ALTER TABLE "school_holiday" ADD CONSTRAINT "school_holiday_schoolId_fkey" FOREIGN KEY ("schoolId") REFERENCES "school"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
