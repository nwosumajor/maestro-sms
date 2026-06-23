-- CreateTable
CREATE TABLE "workflow_request" (
    "id" UUID NOT NULL,
    "schoolId" UUID NOT NULL,
    "type" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'DRAFT',
    "initiatorId" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "workflow_request_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "workflow_audit_log" (
    "id" UUID NOT NULL,
    "schoolId" UUID NOT NULL,
    "requestId" UUID NOT NULL,
    "initiatorId" UUID NOT NULL,
    "approverId" UUID,
    "oldState" TEXT,
    "newState" TEXT NOT NULL,
    "comments" TEXT,
    "timestamp" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "workflow_audit_log_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "workflow_request_schoolId_idx" ON "workflow_request"("schoolId");

-- CreateIndex
CREATE INDEX "workflow_request_schoolId_state_idx" ON "workflow_request"("schoolId", "state");

-- CreateIndex
CREATE INDEX "workflow_request_schoolId_initiatorId_idx" ON "workflow_request"("schoolId", "initiatorId");

-- CreateIndex
CREATE INDEX "workflow_audit_log_schoolId_idx" ON "workflow_audit_log"("schoolId");

-- CreateIndex
CREATE INDEX "workflow_audit_log_schoolId_requestId_idx" ON "workflow_audit_log"("schoolId", "requestId");

-- AddForeignKey
ALTER TABLE "workflow_request" ADD CONSTRAINT "workflow_request_schoolId_fkey" FOREIGN KEY ("schoolId") REFERENCES "school"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workflow_request" ADD CONSTRAINT "workflow_request_initiatorId_fkey" FOREIGN KEY ("initiatorId") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workflow_audit_log" ADD CONSTRAINT "workflow_audit_log_schoolId_fkey" FOREIGN KEY ("schoolId") REFERENCES "school"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workflow_audit_log" ADD CONSTRAINT "workflow_audit_log_requestId_fkey" FOREIGN KEY ("requestId") REFERENCES "workflow_request"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
