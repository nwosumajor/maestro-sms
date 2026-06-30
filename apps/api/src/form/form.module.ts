import { Module } from "@nestjs/common";
import { FormController } from "./form.controller";
import { FormService } from "./form.service";

// Form Builder. Depends on the global FoundationModule (TENANT_DATABASE,
// AUDIT_LOG_SERVICE, auth guard). Anonymity is enforced in the service.
@Module({
  controllers: [FormController],
  providers: [FormService],
  exports: [FormService],
})
export class FormModule {}
