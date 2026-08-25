// =============================================================================
// AuditPartitionProcessor — BullMQ worker for the audit_log partition sweep
// =============================================================================
// Consumes the repeatable job. Like the retention/dunning workers it has no HTTP
// request and is DELIBERATELY privileged (partition DDL); the privilege is
// confined to AuditPartitionService / the shared privileged client.
// =============================================================================

import { Processor, WorkerHost } from "@nestjs/bullmq";
import { JobRunsService } from "../maintenance/job-runs.service";
import type { Job } from "bullmq";
import { AUDIT_PARTITION_JOB, AUDIT_PARTITION_QUEUE } from "./maintenance.constants";
import { AuditPartitionService } from "./audit-partition.service";

@Processor(AUDIT_PARTITION_QUEUE)
export class AuditPartitionProcessor extends WorkerHost {
  // The service logs its own outcome (names ensured + any DEFAULT-partition rows).
  constructor(private readonly partitions: AuditPartitionService,
    private readonly runs: JobRunsService,
  ) {
    super();
  }

  /**
   * What this returns IS the stored run summary, and the operator's jobs console
   * reads its "Partial" badge from a numeric `failed` there. The service
   * computes that; this method used to drop it on the floor while mapping the
   * result, so the one condition the sweep exists to detect — rows piling into
   * the DEFAULT partition — reached the console as ordinary text beside every
   * green row and flagged nothing.
   */
  async process(job: Job): Promise<{ ensured: number; defaultRows: number; failed: number }> {
    return this.runs.record("maintenance.auditPartition", "SCHEDULE", async () => {
      if (job.name !== AUDIT_PARTITION_JOB) return { ensured: 0, defaultRows: 0, failed: 0 };
      const r = await this.partitions.ensureUpcoming();
      return { ensured: r.ensured.length, defaultRows: r.defaultRows, failed: r.failed };
    });
  }
}
