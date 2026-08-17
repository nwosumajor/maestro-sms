import { Processor, WorkerHost } from "@nestjs/bullmq";
import type { Job } from "bullmq";
import { JobRunsService } from "./job-runs.service";
import { INDEX_BLOAT_JOB, INDEX_BLOAT_QUEUE, IndexBloatService, type IndexBloatResult } from "./index-bloat.service";

/** BullMQ worker for the weekly index reclaim. Privileged inside the service —
 *  REINDEX needs the table owner, which is the migration role. */
@Processor(INDEX_BLOAT_QUEUE)
export class IndexBloatProcessor extends WorkerHost {
  constructor(
    private readonly bloat: IndexBloatService,
    private readonly runs: JobRunsService,
  ) {
    super();
  }

  async process(job: Job): Promise<IndexBloatResult> {
    return this.runs.record("maintenance.indexBloat", "SCHEDULE", async () => {
      const zero: IndexBloatResult = {
        invalidDropped: 0, reindexed: 0, bytesReclaimed: 0, remaining: 0, details: [],
      };
      if (job.name !== INDEX_BLOAT_JOB) return zero;
      return this.bloat.reclaim("SCHEDULED");
    });
  }
}
