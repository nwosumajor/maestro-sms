import { Module } from "@nestjs/common";
import { PrivacyController } from "./privacy.controller";
import { ComplianceService } from "./compliance.service";
import { ComplianceController } from "./compliance.controller";
import { PrivacyService } from "./privacy.service";
import { SchoolArchiveService } from "./archive.service";
import { SchoolArchiveController } from "./archive.controller";
import { TermArchiveProcessor } from "./archive.processor";
import { TermArchiveScheduler } from "./archive.scheduler";
import { TERM_ARCHIVE_QUEUE } from "./archive.service";
import { BullModule } from "@nestjs/bullmq";
import { STORAGE_PROVIDER, StubStorageProvider } from "../documents/storage.provider";
import { S3StorageProvider } from "../documents/s3-storage.provider";

// NDPR data-subject rights (export + erasure requests). Depends on the global
// FoundationModule (TENANT_DATABASE, AUDIT_LOG_SERVICE, auth guard). Binds the
// same pluggable StorageProvider as the Document Vault so an APPROVED erasure can
// delete the subject's uploaded submission files (STORAGE_PROVIDER=s3 -> real
// presigner/deleter; otherwise the local stub).
@Module({
  imports: [BullModule.registerQueue({ name: TERM_ARCHIVE_QUEUE })],
  controllers: [PrivacyController, ComplianceController, SchoolArchiveController],
  providers: [
    PrivacyService,
    {
      provide: STORAGE_PROVIDER,
      useClass: process.env.STORAGE_PROVIDER === "s3" ? S3StorageProvider : StubStorageProvider,
    }, ComplianceService, SchoolArchiveService, TermArchiveProcessor, TermArchiveScheduler],
  exports: [PrivacyService],
})
export class PrivacyModule {}
