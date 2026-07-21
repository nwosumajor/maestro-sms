import { Processor, WorkerHost } from "@nestjs/bullmq";
import { Logger } from "@nestjs/common";
import type { Job } from "bullmq";
import {
  FEE_RECONCILE_JOB,
  FEE_RECONCILE_QUEUE,
  PaymentReconciliationService,
  type ReconcileResult,
} from "./reconciliation.service";

/** BullMQ worker for the scheduled reconciliation sweep. Deliberately
 *  privileged inside the service (cross-tenant ledger check) — same posture as
 *  the dunning worker. */
@Processor(FEE_RECONCILE_QUEUE)
export class PaymentReconciliationProcessor extends WorkerHost {
  private readonly logger = new Logger(PaymentReconciliationProcessor.name);

  constructor(private readonly reconcile: PaymentReconciliationService) {
    super();
  }

  async process(job: Job): Promise<ReconcileResult> {
    if (job.name !== FEE_RECONCILE_JOB) return { scanned: 0, invoiceCharges: 0, missing: 0, posted: 0 };
    const r = await this.reconcile.sweep("SCHEDULED");
    this.logger.log(`Reconcile done: scanned=${r.scanned} invoiceCharges=${r.invoiceCharges} missing=${r.missing} posted=${r.posted}`);
    return r;
  }
}
