import { Module } from "@nestjs/common";
import { CertificateController } from "./certificate.controller";
import { CertificateService } from "./certificate.service";

// Certificate / ID-card generator. Depends on the global FoundationModule
// (TENANT_DATABASE, AUDIT_LOG_SERVICE, auth guard). Generates PDFs via pdfkit.
@Module({
  controllers: [CertificateController],
  providers: [CertificateService],
  exports: [CertificateService],
})
export class CertificateModule {}
