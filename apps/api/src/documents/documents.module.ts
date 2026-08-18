import { Module } from "@nestjs/common";
import { DocumentsController } from "./documents.controller";
import { DocumentsService } from "./documents.service";
import { PublicDocumentsController } from "./public-documents.controller";
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
  imports: [NotificationModule],
  // ORDER MATTERS. DocumentsController serves `GET /documents/:id`, which
  // matches any single segment — including the literal `requirements` and
  // `checklist` this module also owns. Nest matches in REGISTRATION order, so
  // the literal routes must come FIRST or the Vault's wildcard swallows them
  // and answers 404 for a document id that was never an id. Exactly the shape
  // of `scan/today` being eaten by `scan/:code`. Pinned by a test.
  controllers: [PublicDocumentsController, SuppliedDocumentsController, DocumentsController],
  providers: [
    DocumentsService,
    SuppliedDocumentsService,
    {
      provide: STORAGE_PROVIDER,
      useClass:
        process.env.STORAGE_PROVIDER === "s3" ? S3StorageProvider : StubStorageProvider,
    },
  ],
  exports: [DocumentsService, SuppliedDocumentsService],
})
export class DocumentsModule {}
