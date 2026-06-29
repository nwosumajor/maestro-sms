import { Module } from "@nestjs/common";
import { PrivacyController } from "./privacy.controller";
import { PrivacyService } from "./privacy.service";
import { STORAGE_PROVIDER, StubStorageProvider } from "../documents/storage.provider";
import { S3StorageProvider } from "../documents/s3-storage.provider";

// NDPR data-subject rights (export + erasure requests). Depends on the global
// FoundationModule (TENANT_DATABASE, AUDIT_LOG_SERVICE, auth guard). Binds the
// same pluggable StorageProvider as the Document Vault so an APPROVED erasure can
// delete the subject's uploaded submission files (STORAGE_PROVIDER=s3 -> real
// presigner/deleter; otherwise the local stub).
@Module({
  controllers: [PrivacyController],
  providers: [
    PrivacyService,
    {
      provide: STORAGE_PROVIDER,
      useClass: process.env.STORAGE_PROVIDER === "s3" ? S3StorageProvider : StubStorageProvider,
    },
  ],
  exports: [PrivacyService],
})
export class PrivacyModule {}
