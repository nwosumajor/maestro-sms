import { Module } from "@nestjs/common";
import { CertificateController } from "./certificate.controller";
import { CertificateService } from "./certificate.service";
import { BrandingModule } from "../branding/branding.module";

// Certificate / ID-card generator. Depends on the global FoundationModule
// (TENANT_DATABASE, AUDIT_LOG_SERVICE, auth guard). Generates PDFs via pdfkit,
// embedding the school logo (BrandingModule) when one is uploaded.
@Module({
  imports: [BrandingModule],
  controllers: [CertificateController],
  providers: [CertificateService],
  exports: [CertificateService],
})
export class CertificateModule {}
