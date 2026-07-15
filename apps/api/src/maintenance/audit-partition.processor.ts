// =============================================================================
// AuditPartitionProcessor — BullMQ worker for the audit_log partition sweep
// =============================================================================
// Consumes the repeatable job. Like the retention/dunning workers it has no HTTP
// request and is DELIBERATELY privileged (partition DDL); the privilege is
// confined to AuditPartitionService / the shared privileged client.
// =============================================================================

import { Processor, WorkerHost } from "@nestjs/bullmq";
import type { Job } from "bullmq";
import { AUDIT_PARTITION_JOB, AUDIT_PARTITION_QUEUE } from "./maintenance.constants";
import { AuditPartitionService } from "./audit-partition.service";

@Processor(AUDIT_PARTITION_QUEUE)
export class AuditPartitionProcessor extends WorkerHost {
  // The service logs its own outcome (names ensured + any DEFAULT-partition rows).
  constructor(private readonly partitions: AuditPartitionService) {
    super();
  }

  async process(job: Job): Promise<{ ensured: number; defaultRows: number }> {
    if (job.name !== AUDIT_PARTITION_JOB) return { ensured: 0, defaultRows: 0 };
    const r = await this.partitions.ensureUpcoming();
    return { ensured: r.ensured.length, defaultRows: r.defaultRows };
  }
}
