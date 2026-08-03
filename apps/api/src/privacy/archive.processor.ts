import { Processor, WorkerHost } from "@nestjs/bullmq";
import { Logger } from "@nestjs/common";
import type { Job } from "bullmq";
import { SchoolArchiveService, TERM_ARCHIVE_JOB, TERM_ARCHIVE_QUEUE } from "./archive.service";

/** Worker for the daily term-boundary archive. Privileged inside the service
 *  (it scans every school's terms) — the same posture as retention and dunning. */
@Processor(TERM_ARCHIVE_QUEUE)
export class TermArchiveProcessor extends WorkerHost {
  private readonly logger = new Logger(TermArchiveProcessor.name);

  constructor(private readonly archives: SchoolArchiveService) {
    super();
  }

  async process(job: Job) {
    const zero = { scanned: 0, archived: 0, skipped: 0 };
    if (job.name !== TERM_ARCHIVE_JOB) return zero;
    const r = await this.archives.archiveEndedTerms("SCHEDULED");
    // At WARN when it actually archived: a new permanent record of the whole
    // institution came into existence, which is worth seeing in the log.
    const line = `Term archive: scanned=${r.scanned} archived=${r.archived} skipped=${r.skipped}`;
    if (r.archived > 0) this.logger.warn(line);
    else this.logger.log(line);
    return r;
  }
}
