import { Processor, WorkerHost } from "@nestjs/bullmq";
import { Logger } from "@nestjs/common";
import { EXEAT_OVERDUE_QUEUE } from "./hostel.constants";
import { ExeatOverdueService } from "./exeat-overdue.service";

@Processor(EXEAT_OVERDUE_QUEUE)
export class ExeatOverdueProcessor extends WorkerHost {
  private readonly logger = new Logger("ExeatOverdueProcessor");

  constructor(private readonly overdue: ExeatOverdueService) {
    super();
  }

  async process(): Promise<void> {
    const r = await this.overdue.sweep();
    // Reports what it FOUND and what it DID — "alerted 0" alone reads as a
    // failure; "0 of 0" and "0 of 12 already alerted" are different facts.
    this.logger.log(`overdue sweep: scanned ${r.scanned}, alerted ${r.alerted}${r.skipped ? ` (skipped: ${r.skipped})` : ""}`);
  }
}
