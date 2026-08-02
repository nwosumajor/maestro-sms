import { Module } from "@nestjs/common";
import { DisciplineController } from "./discipline.controller";
import { DisciplineService } from "./discipline.service";
import { STORAGE_PROVIDER, StubStorageProvider } from "../documents/storage.provider";
import { S3StorageProvider } from "../documents/s3-storage.provider";
import { NotificationModule } from "../notifications/notification.module";

// Discipline Room. Depends on the global FoundationModule. Binds the pluggable
// StorageProvider (same as the Document Vault) for evidence attachments.
// NotificationModule is safe to import here: it imports only BullModule and
// PaymentsModule, neither of which reaches Discipline — so no cycle.
@Module({
  imports: [NotificationModule],
  controllers: [DisciplineController],
  providers: [
    DisciplineService,
    {
      provide: STORAGE_PROVIDER,
      useClass: process.env.STORAGE_PROVIDER === "s3" ? S3StorageProvider : StubStorageProvider,
    },
  ],
  exports: [DisciplineService],
})
export class DisciplineModule {}
