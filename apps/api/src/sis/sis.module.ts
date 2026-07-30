import { Module } from "@nestjs/common";
import { BullModule } from "@nestjs/bullmq";
import { PrivilegedDatabaseService } from "../common/privileged-database.service";
import { SIS_NUDGE_DATABASE, SIS_NUDGE_QUEUE } from "./sis.constants";
import { SisNudgeService } from "./sis-nudge.service";
import { SisNudgeScheduler } from "./sis-nudge.scheduler";
import { SisNudgeProcessor } from "./sis-nudge.processor";
import { NotificationModule } from "../notifications/notification.module";
import { SisController } from "./sis.controller";
import { SisService } from "./sis.service";

// Depends on the global FoundationModule (TENANT_DATABASE, AUDIT_LOG_SERVICE,
// auth guard) — no re-import needed.
@Module({
  imports: [NotificationModule, BullModule.registerQueue({ name: SIS_NUDGE_QUEUE })],
  controllers: [SisController],
  providers: [
    SisService,
    // Daily profile-completion nudge (mirrors the HR reminder / billing dunning
    // pattern): cross-tenant by necessity, so it runs on the PRIVILEGED client.
    SisNudgeService,
    SisNudgeScheduler,
    SisNudgeProcessor,
    { provide: SIS_NUDGE_DATABASE, useExisting: PrivilegedDatabaseService },
  ],
  exports: [SisService, SisNudgeService],
})
export class SisModule {}
