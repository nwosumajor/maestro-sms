import { Module } from "@nestjs/common";
import { MobileMoneyService } from "./mobile-money.service";
import { MobileMoneyController } from "./mobile-money.controller";
import { PaymentsModule } from "./payments.module";
import { SettlementModule } from "../fees/settlement.module";

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
  imports: [PaymentsModule, SettlementModule],
  controllers: [MobileMoneyController],
  providers: [MobileMoneyService],
  exports: [MobileMoneyService],
})
export class MobileMoneyModule {}
