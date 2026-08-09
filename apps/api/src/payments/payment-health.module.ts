import { Module } from "@nestjs/common";
import { BullModule } from "@nestjs/bullmq";
import { PaymentsModule } from "./payments.module";
import { NotificationModule } from "../notifications/notification.module";
import { PAYMENT_HEALTH_QUEUE } from "./payment-health.constants";
import { PaymentHealthService } from "./payment-health.service";
import { PaymentHealthProcessor } from "./payment-health.processor";
import { PaymentHealthScheduler } from "./payment-health.scheduler";

// The payment-rail health check, in its OWN module — the same shape
// MobileMoneyModule and DisputesModule use, and for the same reason.
//
// It CANNOT live in PaymentsModule: this needs NotificationModule (to alert the
// owner), and NotificationModule imports PaymentsModule (for message credits).
// That is a cycle, and Nest refuses to boot on one — which unit tests do not
// catch, because they never build the module graph. PaymentsModule stays a leaf;
// module-graph.spec.ts fails the build if that ever stops being true.
@Module({
  imports: [PaymentsModule, NotificationModule, BullModule.registerQueue({ name: PAYMENT_HEALTH_QUEUE })],
  providers: [PaymentHealthService, PaymentHealthProcessor, PaymentHealthScheduler],
  exports: [PaymentHealthService],
})
export class PaymentHealthModule {}
