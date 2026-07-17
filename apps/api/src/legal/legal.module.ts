import { Module } from "@nestjs/common";
import { LegalController } from "./legal.controller";
import { LegalService } from "./legal.service";

// Clickwrap acceptance of the versioned legal pack. ALWAYS-ON (like billing/
// auth) — a school must be able to accept terms regardless of its module set.
@Module({
  controllers: [LegalController],
  providers: [LegalService],
})
export class LegalModule {}
