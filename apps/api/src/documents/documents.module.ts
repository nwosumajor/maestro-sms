import { Module } from "@nestjs/common";
import { DocumentsController } from "./documents.controller";
import { DocumentsService } from "./documents.service";
import { BullModule } from "@nestjs/bullmq";
import { LocalStorageController } from "./local-storage.controller";
import { PublicDocumentsController } from "./public-documents.controller";
import { SubmissionRetentionService } from "./submission-retention.service";
import { SubmissionRetentionProcessor } from "./submission-retention.processor";
import { SubmissionRetentionScheduler } from "./submission-retention.scheduler";
import { SUBMISSION_RETENTION_QUEUE } from "./submission-retention.constants";
import { MaintenanceModule } from "../maintenance/maintenance.module";
import { PrivilegedDatabaseModule } from "../common/privileged-database.module";
import { PrivilegedDatabaseService } from "../common/privileged-database.service";
import { RETENTION_DATABASE } from "../integrity/integrity.constants";
import { SuppliedDocumentsController } from "./supplied-documents.controller";
import { SuppliedDocumentsService } from "./supplied-documents.service";
import { STORAGE_PROVIDER, StubStorageProvider } from "./storage.provider";
import { S3StorageProvider } from "./s3-storage.provider";
import { NotificationModule } from "../notifications/notification.module";

// Depends on the global FoundationModule (TENANT_DATABASE, AUDIT_LOG_SERVICE,
// auth guard). Imports NotificationModule to alert guardians when a shareable
// student document is uploaded. Storage backend is selected by env: STORAGE_PROVIDER=s3
// binds the real S3/R2 presigner (cloud); anything else keeps the local stub.
@Module({
  imports: [NotificationModule, MaintenanceModule, PrivilegedDatabaseModule, BullModule.registerQueue({ name: SUBMISSION_RETENTION_QUEUE })],
  // ORDER MATTERS. DocumentsController serves `GET /documents/:id`, which
  // matches any single segment — including the literal `requirements` and
  // `checklist` this module also owns. Nest matches in REGISTRATION order, so
  // the literal routes must come FIRST or the Vault's wildcard swallows them
  // and answers 404 for a document id that was never an id. Exactly the shape
  // of `scan/today` being eaten by `scan/:code`. Pinned by a test.
  // The local-storage route exists ONLY alongside the stub provider. With
  // STORAGE_PROVIDER=s3 the presigned URLs go to the bucket and this is not
  // registered at all — a development convenience must not be a production
  // surface, and the surest way is for it not to be there.
  controllers: [
    ...(process.env.STORAGE_PROVIDER === "s3" ? [] : [LocalStorageController]),
    PublicDocumentsController,
    SuppliedDocumentsController,
    DocumentsController,
  ],
  providers: [
    DocumentsService,
    SuppliedDocumentsService,
    // The same privileged client the integrity purge uses, bound here rather
    // than imported from IntegrityModule — which provides the token but does
    // not export it. Binding it locally keeps this module independent of that
    // one, and the app failed to BOOT until it was: 3,069 unit tests passed on
    // a wiring Nest could not resolve.
    { provide: RETENTION_DATABASE, useExisting: PrivilegedDatabaseService },
    SubmissionRetentionService,
    SubmissionRetentionProcessor,
    SubmissionRetentionScheduler,
    {
      provide: STORAGE_PROVIDER,
      useClass:
        process.env.STORAGE_PROVIDER === "s3" ? S3StorageProvider : StubStorageProvider,
    },
  ],
  exports: [DocumentsService, SuppliedDocumentsService, SubmissionRetentionService],
})
export class DocumentsModule {}
