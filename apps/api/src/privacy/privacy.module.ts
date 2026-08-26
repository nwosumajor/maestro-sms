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
import { NotificationModule } from "../notifications/notification.module";
import { BullModule } from "@nestjs/bullmq";
import { STORAGE_PROVIDER, StubStorageProvider } from "../documents/storage.provider";
import { S3StorageProvider } from "../documents/s3-storage.provider";
import { usingS3 } from "../documents/storage-provider.config";
import { BREACH_DEADLINE_DATABASE, BREACH_DEADLINE_QUEUE } from "./privacy.constants";
import { BreachDeadlineService } from "./breach-deadline.service";
import { BreachDeadlineScheduler } from "./breach-deadline.scheduler";
import { BreachDeadlineProcessor } from "./breach-deadline.processor";
import { PrivilegedDatabaseService } from "../common/privileged-database.service";

// NDPR data-subject rights (export + erasure requests). Depends on the global
// FoundationModule (TENANT_DATABASE, AUDIT_LOG_SERVICE, auth guard). Binds the
// same pluggable StorageProvider as the Document Vault so an APPROVED erasure can
// delete the subject's uploaded submission files (STORAGE_PROVIDER=s3 -> real
// presigner/deleter; otherwise the local stub).
@Module({
  // NotificationModule: an erasure request carries a statutory deadline and must
  // reach the person who answers it. SAFE — Notification imports only BullModule
  // and PaymentsModule, neither of which reaches Privacy.
  imports: [
    BullModule.registerQueue({ name: TERM_ARCHIVE_QUEUE }),
    BullModule.registerQueue({ name: BREACH_DEADLINE_QUEUE }),
    NotificationModule,
  ],
  controllers: [PrivacyController, ComplianceController, SchoolArchiveController],
  providers: [
    PrivacyService,
    {
      provide: STORAGE_PROVIDER,
      useClass: usingS3() ? S3StorageProvider : StubStorageProvider,
    },
    ComplianceService,
    SchoolArchiveService,
    TermArchiveProcessor,
    TermArchiveScheduler,
    BreachDeadlineService,
    BreachDeadlineScheduler,
    BreachDeadlineProcessor,
    { provide: BREACH_DEADLINE_DATABASE, useExisting: PrivilegedDatabaseService },
  ],
  exports: [PrivacyService],
})
export class PrivacyModule {}
