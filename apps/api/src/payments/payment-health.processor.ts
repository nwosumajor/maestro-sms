import { Processor, WorkerHost } from "@nestjs/bullmq";
import { Logger } from "@nestjs/common";
import type { Job } from "bullmq";
import { PAYMENT_HEALTH_JOB, PAYMENT_HEALTH_QUEUE } from "./payment-health.constants";
import { PaymentHealthService } from "./payment-health.service";

/** BullMQ worker for the daily payment-rail health check. */
@Processor(PAYMENT_HEALTH_QUEUE)
export class PaymentHealthProcessor extends WorkerHost {
  private readonly logger = new Logger(PaymentHealthProcessor.name);

  constructor(private readonly health: PaymentHealthService) {
    super();
  }

  async process(job: Job): Promise<{ checked: number; broke: number; recovered: number }> {
    if (job.name !== PAYMENT_HEALTH_JOB) return { checked: 0, broke: 0, recovered: 0 };
    const r = await this.health.run("SCHEDULED");
    // "skipped" and "nothing wrong" must never read the same — the lesson the
    // fee sweeps taught (PR #128).
    this.logger.log(
      r.skipped
        ? "Payment health check SKIPPED (no privileged DB) — this is not a report that the rails are healthy."
        : `Payment health: checked=${r.checked.length} down=${r.broke.length} recovered=${r.recovered.length}`,
    );
    return { checked: r.checked.length, broke: r.broke.length, recovered: r.recovered.length };
  }
}
