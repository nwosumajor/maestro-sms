import { Module } from "@nestjs/common";
import { DocumentsController } from "./documents.controller";
import { DocumentsService } from "./documents.service";
import { STORAGE_PROVIDER, StubStorageProvider } from "./storage.provider";
import { S3StorageProvider } from "./s3-storage.provider";
import { NotificationModule } from "../notifications/notification.module";

// Depends on the global FoundationModule (TENANT_DATABASE, AUDIT_LOG_SERVICE,
// auth guard). Imports NotificationModule to alert guardians when a shareable
// student document is uploaded. Storage backend is selected by env: STORAGE_PROVIDER=s3
// binds the real S3/R2 presigner (cloud); anything else keeps the local stub.
@Module({
  imports: [NotificationModule],
  controllers: [DocumentsController],
  providers: [
    DocumentsService,
    {
      provide: STORAGE_PROVIDER,
      useClass:
        process.env.STORAGE_PROVIDER === "s3" ? S3StorageProvider : StubStorageProvider,
    },
  ],
  exports: [DocumentsService],
})
export class DocumentsModule {}
