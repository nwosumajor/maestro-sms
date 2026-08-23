import { Module } from "@nestjs/common";
import { TaskController } from "./task.controller";
import { TaskService } from "./task.service";
import { STORAGE_PROVIDER, StubStorageProvider } from "../documents/storage.provider";
import { S3StorageProvider } from "../documents/s3-storage.provider";
import { usingS3 } from "../documents/storage-provider.config";

// Task System. Depends on the global FoundationModule. Binds the pluggable
// StorageProvider (same as the Document Vault) for assignment attachments.
@Module({
  controllers: [TaskController],
  providers: [
    TaskService,
    {
      provide: STORAGE_PROVIDER,
      useClass: usingS3() ? S3StorageProvider : StubStorageProvider,
    },
  ],
  exports: [TaskService],
})
export class TaskModule {}
