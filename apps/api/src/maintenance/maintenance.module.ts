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
import { INDEX_BLOAT_QUEUE, IndexBloatService } from "./index-bloat.service";
import { IndexBloatScheduler } from "./index-bloat.scheduler";
import { IndexBloatProcessor } from "./index-bloat.processor";

@Module({
  imports: [
    PrivilegedDatabaseModule,
    BullModule.registerQueue({ name: AUDIT_PARTITION_QUEUE }),
    // Its own queue: reclaiming index space is slow I/O and must never sit
    // behind, or in front of, the partition roll.
    BullModule.registerQueue({ name: INDEX_BLOAT_QUEUE }),
  ],
  providers: [AuditPartitionService, AuditPartitionScheduler, AuditPartitionProcessor, IndexBloatService, IndexBloatScheduler, IndexBloatProcessor],
  exports: [AuditPartitionService, IndexBloatService],
})
export class MaintenanceModule {}
