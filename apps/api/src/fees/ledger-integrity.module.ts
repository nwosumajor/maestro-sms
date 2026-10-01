import { Module } from "@nestjs/common";
import { BullModule } from "@nestjs/bullmq";
import { NotificationModule } from "../notifications/notification.module";
import { LedgerIntegrityService, LEDGER_INTEGRITY_QUEUE } from "./ledger-integrity.service";
import { LedgerIntegrityScheduler } from "./ledger-integrity.scheduler";
import { LedgerIntegrityProcessor } from "./ledger-integrity.processor";

// Its OWN module, imported by OperatorModule (which owns the routes). It needs
// only the notification module and the globals (privileged client, tenant
// database, audit, job runs), so it adds no edge that could close a cycle —
// see test/payments/module-graph.spec.ts for why that matters here.
@Module({
  imports: [NotificationModule, BullModule.registerQueue({ name: LEDGER_INTEGRITY_QUEUE })],
  providers: [LedgerIntegrityService, LedgerIntegrityScheduler, LedgerIntegrityProcessor],
  exports: [LedgerIntegrityService],
})
export class LedgerIntegrityModule {}
