import { Module } from "@nestjs/common";
import { TaskController } from "./task.controller";
import { TaskService } from "./task.service";
import { STORAGE_PROVIDER, StubStorageProvider } from "../documents/storage.provider";
import { S3StorageProvider } from "../documents/s3-storage.provider";

// Task System. Depends on the global FoundationModule. Binds the pluggable
// StorageProvider (same as the Document Vault) for assignment attachments.
@Module({
  controllers: [TaskController],
  providers: [
    TaskService,
    {
      provide: STORAGE_PROVIDER,
      useClass: process.env.STORAGE_PROVIDER === "s3" ? S3StorageProvider : StubStorageProvider,
    },
  ],
  exports: [TaskService],
})
export class TaskModule {}
