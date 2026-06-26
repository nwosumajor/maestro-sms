import { Module } from "@nestjs/common";
import { LmsController } from "./lms.controller";
import { LmsService } from "./lms.service";
import { LmsContentController } from "./lms-content.controller";
import { LmsContentService } from "./lms-content.service";
import { WorkflowModule } from "../workflow/workflow.module";
import { NotificationModule } from "../notifications/notification.module";
import { STORAGE_PROVIDER, StubStorageProvider } from "../documents/storage.provider";
import { S3StorageProvider } from "../documents/s3-storage.provider";

// Depends on the global FoundationModule (TENANT_DATABASE, AUDIT_LOG_SERVICE,
// auth guard). Imports WorkflowModule for approval-gated content publication, and
// binds the same pluggable StorageProvider as the Document Vault for PDF uploads
// (STORAGE_PROVIDER=s3 -> real presigner; otherwise the local stub).
@Module({
  imports: [WorkflowModule, NotificationModule],
  controllers: [LmsController, LmsContentController],
  providers: [
    LmsService,
    LmsContentService,
    {
      provide: STORAGE_PROVIDER,
      useClass:
        process.env.STORAGE_PROVIDER === "s3" ? S3StorageProvider : StubStorageProvider,
    },
  ],
  exports: [LmsService],
})
export class LmsModule {}
