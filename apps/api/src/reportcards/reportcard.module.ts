import { Module } from "@nestjs/common";
import { ReportCardController } from "./reportcard.controller";
import { ReportCardService } from "./reportcard.service";
import { BrandingModule } from "../branding/branding.module";
import { DocumentsModule } from "../documents/documents.module";

// DocumentsModule provides DocumentsService — the generated PDF is persisted
// into the Document Vault (one-way dep reportcards -> documents, no cycle) so
// the student/parent can retrieve their own copy independent of who generated
// it; DocumentsModule's own NotificationModule import covers the guardian alert.
@Module({
  imports: [BrandingModule, DocumentsModule],
  controllers: [ReportCardController],
  providers: [ReportCardService],
  exports: [ReportCardService],
})
export class ReportCardModule {}
