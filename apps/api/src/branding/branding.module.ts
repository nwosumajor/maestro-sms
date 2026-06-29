import { Module } from "@nestjs/common";
import { BrandingController } from "./branding.controller";
import { BrandingService } from "./branding.service";
import { STORAGE_PROVIDER, StubStorageProvider } from "../documents/storage.provider";
import { S3StorageProvider } from "../documents/s3-storage.provider";

// Per-school login-page logo. Storage backend selected by env (same as documents):
// STORAGE_PROVIDER=s3 binds the real presigner, else the local stub.
@Module({
  controllers: [BrandingController],
  providers: [
    BrandingService,
    {
      provide: STORAGE_PROVIDER,
      useClass: process.env.STORAGE_PROVIDER === "s3" ? S3StorageProvider : StubStorageProvider,
    },
  ],
  exports: [BrandingService],
})
export class BrandingModule {}
