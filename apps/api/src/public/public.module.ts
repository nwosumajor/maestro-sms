import { Module } from "@nestjs/common";
import { BillingModule } from "../billing/billing.module";
import { PublicController } from "./public.controller";
import { PublicService } from "./public.service";

// BillingModule provides PlanPricingService — the public pricing endpoint serves
// the same effective (operator-overridable) prices checkout charges, so the
// landing page can never drift from what schools are actually billed.
@Module({
  imports: [BillingModule],
  controllers: [PublicController],
  providers: [PublicService],
  exports: [PublicService],
})
export class PublicModule {}
