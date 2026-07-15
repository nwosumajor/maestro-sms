// =============================================================================
// MaintenanceModule — scheduled DB housekeeping (scaling Phase 5)
// =============================================================================
// Currently: rolling audit_log's monthly partitions forward. Kept in its own
// module (rather than FoundationModule, which is @Global) so the BullMQ queue
// registration stays local, mirroring how retention / dunning own theirs.
// =============================================================================

import { BullModule } from "@nestjs/bullmq";
import { Module } from "@nestjs/common";
import { PrivilegedDatabaseModule } from "../common/privileged-database.module";
import { AUDIT_PARTITION_QUEUE } from "./maintenance.constants";
import { AuditPartitionService } from "./audit-partition.service";
import { AuditPartitionScheduler } from "./audit-partition.scheduler";
import { AuditPartitionProcessor } from "./audit-partition.processor";

@Module({
  imports: [PrivilegedDatabaseModule, BullModule.registerQueue({ name: AUDIT_PARTITION_QUEUE })],
  providers: [AuditPartitionService, AuditPartitionScheduler, AuditPartitionProcessor],
  exports: [AuditPartitionService],
})
export class MaintenanceModule {}
