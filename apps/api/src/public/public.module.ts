import { Module } from "@nestjs/common";
import { BillingModule } from "../billing/billing.module";
import { NotificationModule } from "../notifications/notification.module";
import { PublicController } from "./public.controller";
import { PublicService } from "./public.service";

// BillingModule provides PlanPricingService — the public pricing endpoint serves
// the same effective (operator-overridable) prices checkout charges, so the
// landing page can never drift from what schools are actually billed.
// NotificationModule: a new onboarding request alerts the platform owners in-app.
@Module({
  imports: [BillingModule, NotificationModule],
  controllers: [PublicController],
  providers: [PublicService],
  exports: [PublicService],
})
export class PublicModule {}
