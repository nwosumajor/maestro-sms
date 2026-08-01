import { Module } from "@nestjs/common";
import { BullModule } from "@nestjs/bullmq";
import { MobileMoneyService } from "./mobile-money.service";
import { MobileMoneyController } from "./mobile-money.controller";
import { PaymentsModule } from "./payments.module";
import { SettlementModule } from "../fees/settlement.module";
import { MM_RECOVERY_QUEUE } from "./mobile-money.service";
import { MobileMoneyRecoveryProcessor } from "./mobile-money-recovery.processor";
import { MobileMoneyRecoveryScheduler } from "./mobile-money-recovery.scheduler";

// The mobile-money rail, in its OWN module — the same shape DisputesModule uses.
//
// It cannot live in PaymentsModule: NotificationModule imports PaymentsModule (for
// message credits), and this needs SettlementModule, which imports
// NotificationModule. That is a cycle, and Nest refuses to boot on it — which unit
// tests do NOT catch, because they never build the module graph.
//
// Imported by FeesModule. Imports PaymentsModule (rail adapters, gateway-event log)
// and SettlementModule (the ONE idempotent posting path); is imported by neither.
@Module({
  imports: [PaymentsModule, SettlementModule, BullModule.registerQueue({ name: MM_RECOVERY_QUEUE })],
  controllers: [MobileMoneyController],
  providers: [MobileMoneyService, MobileMoneyRecoveryProcessor, MobileMoneyRecoveryScheduler],
  exports: [MobileMoneyService],
})
export class MobileMoneyModule {}
